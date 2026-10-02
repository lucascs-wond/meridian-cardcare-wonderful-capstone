import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({
  amount: s
    .optional(s.number())
    .describe("Exact payment amount in dollars. Omit it together with amount_type to have the quote resolve it."),
  amount_type: s
    .optional(s.enum("minimum_due", "statement_balance", "full_balance"))
    .describe("Resolve the amount from the account instead of a custom number"),
  confirmed: s
    .optional(s.boolean())
    .describe(
      "TWO-PHASE, STRICT: omit on the first call — it only quotes the payment for read-back. Only after the customer explicitly confirms the exact spoken amount may you call again with confirmed: true and the same amount."
    ),
});

export default w.tool({
  name: "account-make-payment",
  description:
    "Makes a card payment from the bank account on file, completed during the call. Two phases: first call WITHOUT confirmed resolves and quotes the amount to read back; second call WITH confirmed: true and the exact quoted amount submits it. Requires prior identity verification. Never pass confirmed: true on the first call.",
  params,
  handler: async (ctx: Context, input) => {
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
        agent_notes: ["Re-run verify-identity or escalate via escalate-to-human."],
      };
    }

    // Phase 1 — resolve and quote.
    if (input.confirmed !== true) {
      const res = await callFn(ctx, "account-overview", { customer_id: auth.customer_id, account_id: accountId });
      if (!res.ok || (res.result && res.result.error)) {
        return {
          error: "service_unavailable",
          message: "The account service is not responding right now.",
          agent_notes: ["Apologize briefly and offer to try again shortly or escalate-to-human."],
        };
      }
      const ov = res.result;
      let amount: number | null = typeof input.amount === "number" ? input.amount : null;
      if (input.amount_type === "minimum_due") amount = Number(ov.min_payment_due);
      if (input.amount_type === "statement_balance") amount = Number(ov.statement_balance);
      if (input.amount_type === "full_balance") amount = Number(ov.current_balance);
      if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        return {
          needs_amount: true,
          minimum_due: ov.min_payment_due,
          statement_balance: ov.statement_balance,
          current_balance: ov.current_balance,
          agent_notes: [
            "Ask how much they'd like to pay: the minimum due, the statement balance, the full balance, or another amount — then quote it.",
          ],
        };
      }
      if (amount > Number(ov.current_balance)) {
        return {
          error: "amount_exceeds_balance",
          current_balance: ov.current_balance,
          agent_notes: [
            `$${amount.toFixed(2)} is more than the current balance of $${Number(ov.current_balance).toFixed(2)} — we don't accept overpayments. Offer the full balance instead.`,
          ],
        };
      }
      return {
        quote: true,
        amount,
        agent_notes: [
          `QUOTE ONLY — nothing was paid yet. Read back: a payment of $${amount.toFixed(2)} from the bank account on file, posting within 1 business day.`,
          "Only after the customer explicitly says yes, call again with confirmed: true and this exact amount.",
        ],
      };
    }

    // Phase 2 — submit.
    if (typeof input.amount !== "number") {
      return {
        error: "missing_amount",
        message: "confirmed: true requires the exact quoted amount.",
        agent_notes: ["Re-quote the payment first; never confirm without the exact amount."],
      };
    }
    const pay = await callFn(ctx, "payment-submit", {
      customer_id: auth.customer_id,
      account_id: accountId,
      amount: input.amount,
    });
    if (!pay.ok) {
      return {
        error: "service_unavailable",
        message: "The payment could not be submitted right now.",
        agent_notes: ["payment-submit failed twice. Apologize; offer to try again shortly or escalate-to-human. The payment was NOT made."],
      };
    }
    if (pay.result && pay.result.error) {
      return pay.result;
    }

    await recordFact(ctx, {
      tool: "account-make-payment",
      intent: "account/payment_made",
      action: `payment_submitted:${pay.result.payment_id}`,
    });
    return pay.result;
  },
});
