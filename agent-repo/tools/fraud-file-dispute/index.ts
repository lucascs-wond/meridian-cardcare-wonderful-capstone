import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { FN_PREFIX } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { describeDisputeStatus, NEVER_GUESS_NOTE, type DisputeRow } from "../../shared/dispute-status";

const params = s.object({
  transaction_id: s
    .optional(s.string())
    .describe("Exact transaction ID if already known (e.g. from fraud-list-suspicious-activity). Preferred when available."),
  merchant: s
    .optional(s.string())
    .describe("Merchant name (full or partial) used to find the transaction when no transaction_id is known"),
  amount: s
    .optional(s.number())
    .describe("Transaction amount in dollars, used to narrow the search"),
  date: s
    .optional(s.string())
    .describe("Transaction date as YYYY-MM-DD, used to narrow the search"),
  reason: s
    .enum(
      "unauthorized_transaction",
      "duplicate_charge",
      "goods_not_received",
      "incorrect_amount",
      "subscription_cancellation"
    )
    .describe("Dispute reason category"),
  description: s
    .optional(s.string())
    .describe(
      "The customer's OWN words describing the problem — for unauthorized charges this is their attestation and the review needs it, so collect it before filing"
    ),
  merchant_contacted: s
    .optional(s.boolean())
    .describe(
      "goods_not_received / subscription_cancellation: whether the customer already contacted the merchant — ask before filing"
    ),
  expected_delivery_date: s
    .optional(s.string())
    .describe("goods_not_received: the promised delivery date as YYYY-MM-DD, if the customer knows it"),
  stated_correct_amount: s
    .optional(s.number())
    .describe("incorrect_amount: the amount the customer says the charge should have been"),
});

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

export default w.tool({
  name: "fraud-file-dispute",
  description:
    "Files a transaction dispute for the verified customer. Finds the transaction by merchant/amount/date when no transaction_id is given. Disputes must be within 60 days of the charge.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    const accountId = auth.primary_account_id || (Array.isArray(auth.account_ids) ? auth.account_ids[0] : null);
    if (!accountId) {
      return {
        error: "account_not_found",
        message: "No account is linked to the verified session.",
        agent_notes: ["Verification did not record an account. Re-run verify-identity or escalate via escalate-to-human."],
      };
    }

    // Resolve the transaction: explicit ID, or search by merchant/amount/date.
    let transactionId = input.transaction_id ?? null;
    let matched: { transaction_id?: string; date?: string; merchant?: string; amount?: number } | null = null;
    if (!transactionId) {
      if (!input.merchant && input.amount == null && !input.date) {
        // Clarify branch: nothing to search on.
        return {
          error: "missing_transaction_details",
          message: "There is not enough information to find the transaction.",
          agent_notes: [
            "Ask for the merchant name, the amount, or the approximate date of the charge, then call fraud-file-dispute again.",
          ],
        };
      }

      let search;
      try {
        // 90-day lookback so out-of-window charges are still found (the 60-day rule is
        // enforced by mcc-dispute-create, which lets us explain the policy instead of "not found").
        search = await runFn(ctx, `${FN_PREFIX}transactions-search`, {
          account_id: accountId,
          days: 90,
          merchant: input.merchant,
          limit: 25,
        });
      } catch (e) {
        return {
          error: "service_unavailable",
          message: "Transactions could not be searched right now.",
          agent_notes: ["Transaction search failed twice. Apologize and offer to try again shortly or escalate-to-human."],
        };
      }
      if (search && search.error) {
        return search;
      }

      let candidates: Array<{ transaction_id?: string; date?: string; merchant?: string; amount?: number }> =
        Array.isArray(search.transactions) ? search.transactions : [];
      if (input.amount != null) {
        candidates = candidates.filter((t) => Math.abs(Number(t.amount) - Number(input.amount)) < 0.005);
      }
      if (input.date) {
        candidates = candidates.filter((t) => t.date === input.date);
      }

      if (candidates.length === 0) {
        // Clarify branch: no match with the given details.
        return {
          error: "transaction_not_found",
          message: "No transaction matched those details.",
          agent_notes: [
            "No matching charge was found in the last 90 days. Ask the customer to re-confirm the merchant name, amount, or date.",
            "For general browsing, account-search-transactions can help the customer spot the charge first.",
          ],
        };
      }
      if (candidates.length > 1) {
        // Ambiguity branch: list candidates and ask which one.
        return {
          needs_clarification: true,
          match_count: candidates.length,
          candidates: candidates.map((t) => ({
            transaction_id: t.transaction_id ?? null,
            date: t.date,
            merchant: t.merchant,
            amount: t.amount,
          })),
          agent_notes: [
            `Multiple matching charges: ${candidates
              .map((t) => `${t.merchant} for $${t.amount} on ${t.date}`)
              .join("; ")}.`,
            "Read them back and ask which one to dispute, then call fraud-file-dispute again with its transaction_id (or an exact amount and date).",
          ],
        };
      }

      matched = candidates[0];
      transactionId = matched.transaction_id ?? null;
      if (!transactionId) {
        return {
          error: "transaction_id_unavailable",
          message: "The matched transaction has no ID to dispute against.",
          agent_notes: ["Search matched a charge but returned no transaction_id. Escalate via escalate-to-human to file manually."],
        };
      }
    }

    let dispute;
    try {
      dispute = await runFn(ctx, `${FN_PREFIX}dispute-create`, {
        customer_id: auth.customer_id,
        account_id: accountId,
        transaction_id: transactionId,
        reason: input.reason,
        description: input.description,
        // Evidence captured at intake — the backoffice rulebook decides on these.
        customer_stated_details: input.description,
        merchant_contacted: input.merchant_contacted,
        expected_delivery_date: input.expected_delivery_date,
        stated_correct_amount: input.stated_correct_amount,
        channel: "voice",
      });
    } catch (e) {
      return {
        error: "service_unavailable",
        message: "The dispute could not be filed right now.",
        agent_notes: ["dispute-create failed twice. Apologize, and offer a callback or escalate-to-human so the dispute is not lost."],
      };
    }

    if (dispute && dispute.error === "dispute_window_expired") {
      // Policy branch: outside the 60-day dispute window — explain with empathy, don't just refuse.
      return {
        error: "dispute_window_expired",
        message: dispute.message || "This charge is older than the 60-day dispute window.",
        agent_notes: [
          "Deliver this empathetically: card network rules only allow disputes within 60 days of the transaction date, and this charge falls outside that window.",
          "Acknowledge the frustration, then suggest contacting the merchant directly for a refund.",
          "Offer the card-knowledge policy details if they want them, or escalate-to-human if they push back.",
        ],
      };
    }
    if (dispute && dispute.error === "already_disputed") {
      // Don't leave the agent with a status it can't check (that's how it hallucinates
      // "a specialist is reviewing"): fetch the existing case's REAL state right here.
      let existing: DisputeRow | null = null;
      try {
        const statusRes = await runFn(ctx, `${FN_PREFIX}dispute-status`, { customer_id: auth.customer_id });
        const all: DisputeRow[] = Array.isArray(statusRes?.disputes) ? statusRes.disputes : [];
        const amt = matched?.amount ?? input.amount ?? null;
        existing =
          (amt != null && all.find((d) => d.amount != null && Math.abs(Number(d.amount) - Number(amt)) < 0.005)) ||
          all[0] ||
          null;
      } catch (e) {
        // fall through to the honest-unknown branch
      }
      if (existing) {
        return {
          error: "already_disputed",
          message: dispute.message,
          existing_dispute: existing,
          agent_notes: [
            "A dispute already exists for this charge — do NOT file again.",
            describeDisputeStatus(existing),
            `Give the customer this real status and the case id ${existing.dispute_id}. ${NEVER_GUESS_NOTE}`,
          ],
        };
      }
      return {
        error: "already_disputed",
        message: dispute.message,
        agent_notes: [
          "A dispute already exists for this charge — do NOT file again.",
          "The status lookup failed, so the case's current state is UNKNOWN. Do NOT guess or invent a status — tell the customer you can't pull it up right now and offer a follow-up or escalate-to-human.",
        ],
      };
    }
    if (dispute && dispute.error) {
      return dispute;
    }

    await recordFact(ctx, {
      tool: "fraud-file-dispute",
      intent: "fraud/dispute_filed",
      action: `dispute_created:${dispute.dispute_id}`,
    });

    return {
      dispute_id: dispute.dispute_id,
      case_id: dispute.case_id ?? dispute.dispute_id,
      transaction_id: transactionId,
      merchant: matched ? matched.merchant ?? null : null,
      amount: matched ? matched.amount ?? null : null,
      reason: input.reason,
      case_state: dispute.case_state ?? "received",
      expected_resolution_date: dispute.expected_resolution_date ?? null,
      agent_notes: [
        `Dispute case ${dispute.dispute_id} was filed. Confirm the merchant and amount back to the customer and give them the case id.`,
        "Do NOT promise a provisional credit at filing — a specialist review decides the outcome, including any credit.",
        "Tell the customer: the review usually completes within 1 business day, and we will call them with the outcome (after a heads-up text).",
      ],
    };
  },
});
