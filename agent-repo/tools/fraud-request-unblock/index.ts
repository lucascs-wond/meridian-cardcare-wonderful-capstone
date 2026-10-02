import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { FN_PREFIX } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { renderTemplate } from "../../shared/sms-templates";
import { createCase } from "../../shared/review-platform";
import { nowIso } from "../../shared/dates";

const params = s.object({
  card_last4: s
    .optional(s.string())
    .describe("Last 4 digits of the blocked card to unblock. Omit if the customer did not specify — the tool resolves it or asks."),
  stated_reason: s
    .string()
    .describe("The customer's own words for why the card should be unblocked (passed to the human reviewer)"),
});

// Card statuses that a reviewer can consider unblocking.
const BLOCKED_STATUSES = ["blocked", "reported_lost"];

// Data-plane call with one retry on transient failure; throws after the second failure.
async function runFn(ctx: Context, slug: string, fnParams: Record<string, unknown>) {
  try {
    const { result } = await ctx.functions.run({ slug, params: fnParams });
    return result;
  } catch (firstError) {
    const { result } = await ctx.functions.run({ slug, params: fnParams });
    return result;
  }
}

// HITL escalation flow (architecture §4.3):
// VERIFY_AUTH → LOAD_CARD → { not blocked → INFORM | pending case → STATUS | blocked → CREATE_CASE → SMS }
// with an error branch (retry once → apologize + offer callback). Unblocking is NEVER done here —
// only the review platform's approve path can reactivate a card.
export default w.tool({
  name: "fraud-request-unblock",
  description:
    "Files a human-review unblock request for a blocked card with the external review desk. The card is NOT unblocked immediately — a specialist decides within 4 business hours. Requires prior identity verification.",
  params,
  handler: async (ctx, input) => {
    // VERIFY_AUTH
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    // Duplicate guard: a case already filed this session → return its status instead of re-filing.
    // (kv is async — exists/get must be awaited or the guard always fires.)
    if (await ctx.kv.exists("unblock_case")) {
      const existing = await ctx.kv.get("unblock_case");
      if (!input.card_last4 || existing.card_last4 === input.card_last4) {
        return {
          case_id: existing.case_id,
          status: "pending",
          card_last4: existing.card_last4,
          agent_notes: [
            `An unblock case (${existing.case_id}) is already pending for card ending ${existing.card_last4} — do not file another.`,
            "Remind the customer a specialist reviews within 4 business hours; offer fraud-check-unblock-status for updates.",
          ],
        };
      }
    }

    // LOAD_CARD
    let customer;
    try {
      customer = await runFn(ctx, `${FN_PREFIX}customers-lookup`, { customer_id: auth.customer_id });
    } catch (e) {
      return {
        error: "service_unavailable",
        message: "I could not load the card list right now.",
        agent_notes: ["Data lookup failed twice. Apologize and offer to try again shortly or transfer via escalate-to-human."],
      };
    }
    if (!customer || customer.error) {
      return {
        error: "customer_not_found",
        message: "The customer profile could not be loaded.",
        agent_notes: ["Profile lookup returned no customer. Re-verify identity or escalate via escalate-to-human."],
      };
    }

    const cards = Array.isArray(customer.cards) ? customer.cards : [];
    let card;
    if (input.card_last4) {
      card = cards.find((c: { last4: string }) => c.last4 === input.card_last4);
      if (!card) {
        return {
          error: "card_not_found",
          message: `There is no card ending ${input.card_last4} on this profile.`,
          agent_notes: [
            `Cards on file end in: ${cards.map((c: { last4: string }) => c.last4).join(", ") || "none"}.`,
            "Ask the customer to re-confirm the last four digits, then call fraud-request-unblock again.",
          ],
        };
      }
      if (!BLOCKED_STATUSES.includes(card.status)) {
        // INFORM branch: nothing to unblock.
        return {
          card_last4: card.last4,
          card_status: card.status,
          case_created: false,
          agent_notes: [
            `Card ending ${card.last4} is ${card.status}, not blocked — no unblock request is needed.`,
            "Inform the customer and ask what else they need.",
          ],
        };
      }
    } else {
      const blocked = cards.filter((c: { status: string }) => BLOCKED_STATUSES.includes(c.status));
      if (blocked.length === 0) {
        // INFORM branch: nothing to unblock.
        return {
          case_created: false,
          message: "None of the customer's cards are blocked.",
          agent_notes: [
            `Card statuses on file: ${cards.map((c: { last4: string; status: string }) => `ending ${c.last4} is ${c.status}`).join("; ") || "no cards"}.`,
            "Tell the customer no card is blocked; nothing to unblock.",
          ],
        };
      }
      if (blocked.length > 1) {
        // Ambiguity branch: multiple blocked cards and no last4 given — ask, do not guess.
        return {
          needs_clarification: true,
          blocked_cards: blocked.map((c: { last4: string }) => c.last4).join(", "),
          agent_notes: [
            `Multiple blocked cards: ${blocked
              .map((c: { last4: string; block_reason: string | null }) => `ending ${c.last4} (${c.block_reason || "blocked"})`)
              .join(", ")}.`,
            "Ask which card the customer wants reviewed, then call fraud-request-unblock again with card_last4.",
          ],
        };
      }
      card = blocked[0];
    }

    // CREATE_CASE — real HTTPS POST to the review platform's public API (retry once on network failure).
    const payload = {
      customer_id: auth.customer_id,
      card_id: card.card_id,
      card_last4: card.last4,
      block_reason: card.block_reason || card.status,
      customer_stated_reason: input.stated_reason,
      channel: (ctx.metadata && ctx.metadata.communication && ctx.metadata.communication.type) || "voice",
      timestamp: nowIso(),
    };
    let created;
    try {
      created = await createCase(ctx, payload);
    } catch (firstError) {
      try {
        created = await createCase(ctx, payload);
      } catch (secondError) {
        await recordFact(ctx, {
          tool: "fraud-request-unblock",
          intent: "fraud/unblock_request",
          outcome: "review_platform_unavailable",
        });
        return {
          error: "review_platform_unavailable",
          message: "The card review desk cannot be reached right now.",
          agent_notes: [
            "The review platform API failed twice. Apologize sincerely — the unblock request was NOT filed.",
            "Offer a callback once the review desk is reachable, or transfer now via escalate-to-human.",
          ],
        };
      }
    }

    if (created && created.error === "case_already_pending") {
      // API-side duplicate guard (e.g. case filed on a previous call) → return its status instead.
      if (created.case_id) {
        await ctx.kv.set("unblock_case", { case_id: created.case_id, card_last4: card.last4, created_at: nowIso() });
      }
      return {
        case_id: created.case_id ?? null,
        status: "pending",
        card_last4: card.last4,
        agent_notes: [
          `A review case for card ending ${card.last4} is already pending${created.case_id ? ` (case ${created.case_id})` : ""} — do not file another.`,
          "Remind the customer of the 4-business-hour review SLA; offer fraud-check-unblock-status for updates.",
        ],
      };
    }
    if (created && created.error) {
      return created;
    }

    await ctx.kv.set("unblock_case", { case_id: created.case_id, card_last4: card.last4, created_at: nowIso() });

    // SMS confirmation — respects sms_opt_in; failure must not fail the case.
    let smsSent = false;
    if (customer.sms_opt_in === true && customer.phone) {
      try {
        const message = renderTemplate("unblock_case_received", {
          last4: card.last4,
          case_id: created.case_id,
        });
        ctx.telephony.sendSms(customer.phone, message, { senderId: "Meridian" });
        smsSent = true;
      } catch (smsError) {
        console.error("unblock_case_received SMS failed", smsError);
      }
    }

    await recordFact(ctx, {
      tool: "fraud-request-unblock",
      intent: "fraud/unblock_request",
      action: `unblock_case_created:${created.case_id}`,
      sms: smsSent ? "unblock_case_received" : undefined,
    });

    return {
      case_id: created.case_id,
      status: "pending",
      sla: created.sla || "4 business hours",
      card_last4: card.last4,
      sms_sent: smsSent,
      agent_notes: [
        `Unblock case ${created.case_id} was created for card ending ${card.last4}.`,
        "Tell the customer a human specialist will review it within 4 business hours and the decision will arrive by text.",
        "The card stays blocked until a reviewer approves — never promise an immediate unblock.",
        smsSent
          ? "A confirmation SMS with the case number was sent."
          : "No SMS was sent (opt-out or send failure) — read the case number aloud so the customer can note it.",
      ],
    };
  },
});
