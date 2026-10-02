import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { getStatus } from "../../shared/review-platform";
import { todayYmd } from "../../shared/dates";
import {
  cardBlocked,
  unblockCaseReceived,
  unblockDecision,
  paymentReminder,
} from "../../shared/sms-templates";

/**
 * Sends one of the 4 contractual SMS confirmations (contracts §8).
 * Fill-ins come from KV/session state and the mcc- data functions — never
 * from hardcoded values. Respects the sms_opt_in flag cached in the auth KV
 * by verify-identity.
 */

const params = s.object({
  template: s
    .enum(
      "card_blocked",
      "unblock_case_received",
      "unblock_decision",
      "payment_reminder"
    )
    .describe("Which contractual SMS template to send."),
  to: s
    .optional(s.string())
    .describe(
      "Destination phone in E.164. Omit to use the verified customer's phone on file."
    ),
});

function skipped(template: string, notes: string[]) {
  return { sent: false, template, agent_notes: notes };
}

/** Resolve template fill-ins from session state + data functions. */
async function buildMessage(
  ctx: Context,
  template: string,
  auth: { customer_id?: string; primary_account_id?: string }
): Promise<{ ok: true; message: string } | { ok: false; notes: string[] }> {
  if (template === "card_blocked") {
    const lookup = await callFn(ctx, "customers-lookup", {
      customer_id: auth.customer_id,
    });
    if (!lookup.ok || lookup.result?.error) {
      return { ok: false, notes: ["Could not load card details for the SMS. Tell the customer the text may arrive later."] };
    }
    const blocked = (lookup.result.cards ?? []).find(
      (c: any) => c.status === "blocked" || c.status === "reported_lost"
    );
    if (!blocked) {
      return { ok: false, notes: ["No blocked card found on file — nothing to confirm by SMS."] };
    }
    // Replacement details, when present, were stashed by fraud-block-card.
    let replacementLine = "can be ordered any time by calling us";
    if (await ctx.kv.exists("last_card_block")) {
      const block = (await ctx.kv.get("last_card_block")) as any;
      if (block?.replacement_ordered) {
        replacementLine = `is on the way${block.replacement_eta ? `, arriving ${block.replacement_eta}` : ""}`;
      }
    }
    return {
      ok: true,
      message: cardBlocked({
        last4: blocked.last4,
        reason: String(blocked.block_reason ?? "customer request"),
        date: todayYmd(),
        replacement_line: replacementLine,
      }),
    };
  }

  if (template === "unblock_case_received") {
    if (!(await ctx.kv.exists("unblock_case"))) {
      return { ok: false, notes: ["No unblock case exists in this session. Create one with fraud-request-unblock first."] };
    }
    const kase = (await ctx.kv.get("unblock_case")) as any;
    return {
      ok: true,
      message: unblockCaseReceived({
        last4: String(kase.card_last4),
        case_id: String(kase.case_id),
      }),
    };
  }

  if (template === "unblock_decision") {
    let caseId: string | null = null;
    let last4 = "";
    if (await ctx.kv.exists("unblock_case")) {
      const kase = (await ctx.kv.get("unblock_case")) as any;
      caseId = kase.case_id;
      last4 = String(kase.card_last4 ?? "");
    }
    const status = await getStatus(
      ctx,
      caseId ? { case_id: caseId } : { customer_id: auth.customer_id }
    );
    if (status.error) {
      return { ok: false, notes: ["Could not reach the review platform for the decision. Do not send the SMS; offer to check again later."] };
    }
    const decision = status.decision;
    if (!decision) {
      return { ok: false, notes: ["The case has no decision yet — only send this SMS after a decision exists."] };
    }
    const notesLine = status.reviewer_notes
      ? String(status.reviewer_notes)
      : decision === "approve"
        ? "Your card is active again."
        : "Call us if you have questions.";
    return {
      ok: true,
      message: unblockDecision({
        case_id: String(status.case_id ?? caseId),
        last4,
        decision: decision === "approve" ? "approved" : "denied",
        notes_line: notesLine,
      }),
    };
  }

  // payment_reminder
  const overview = await callFn(ctx, "account-overview", {
    account_id: auth.primary_account_id,
  });
  if (!overview.ok || overview.result?.error) {
    return { ok: false, notes: ["Could not load the account for the payment reminder SMS."] };
  }
  const lookup = await callFn(ctx, "customers-lookup", {
    customer_id: auth.customer_id,
  });
  const activeCard = lookup.ok
    ? (lookup.result?.cards ?? []).find((c: any) => c.status === "active")
    : null;
  return {
    ok: true,
    message: paymentReminder({
      min_payment: `$${Number(overview.result.min_payment_due ?? 0).toFixed(2)}`,
      last4: String(activeCard?.last4 ?? "on file"),
      due_date: String(overview.result.payment_due_date ?? "soon"),
    }),
  };
}

export default w.tool({
  name: "send-sms-confirmation",
  description:
    "Sends a templated confirmation SMS to the verified customer (card blocked, unblock case " +
    "received, unblock decision, or payment reminder). Requires prior verify-identity. " +
    "Respects the customer's SMS opt-out. Returns whether the SMS was sent.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    if (auth.sms_opt_in === false) {
      return skipped(input.template, [
        "The customer has opted out of SMS. Do not send texts; share the confirmation verbally instead.",
      ]);
    }

    const to = input.to ?? auth.phone;
    if (!to) {
      return skipped(input.template, [
        "No destination phone number is available. Ask the customer which number to text.",
      ]);
    }

    const built = await buildMessage(ctx, input.template, auth);
    if (!built.ok) {
      return skipped(input.template, built.notes);
    }

    try {
      await ctx.telephony.sendSms(to, built.message, { senderId: "Meridian" });
    } catch (err: any) {
      return {
        error: "sms_send_failed",
        message: err?.message ? String(err.message) : "SMS send failed.",
        agent_notes: [
          "The SMS could not be sent. Apologize and share the confirmation details verbally.",
        ],
      };
    }

    await recordFact(ctx, {
      tool: "send-sms-confirmation",
      action: `sms_${input.template}`,
      sms: input.template,
    });

    return {
      sent: true,
      template: input.template,
      agent_notes: [
        "Confirmation SMS sent. Tell the customer a text is on its way to their phone on file.",
      ],
    };
  },
});
