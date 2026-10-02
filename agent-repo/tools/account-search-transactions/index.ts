import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({
  days: s
    .optional(s.number())
    .describe("Look-back window in days. Defaults to 30. Use 60 or 90 when the customer asks about older activity."),
  merchant: s
    .optional(s.string())
    .describe("Merchant name to filter by, as the customer said it (partial match is fine)."),
  category: s
    .optional(s.string())
    .describe("Spending category to filter by, e.g. groceries, travel, dining."),
  status: s
    .optional(s.enum("posted", "pending", "declined"))
    .describe("Transaction status filter. Omit to include all statuses."),
  limit: s
    .optional(s.number())
    .describe("Maximum number of transactions to return. Defaults to 10."),
});

export default w.tool({
  name: "account-search-transactions",
  description:
    "Searches the verified customer's recent transactions with optional merchant, category, status, and date-window filters. Use for 'what did I spend at X', 'my last charges', or finding a specific purchase. For charges the customer does NOT recognize, use the fraud tools instead.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    if (!auth.primary_account_id) {
      return {
        error: "no_account_on_file",
        message: "The verified customer has no open account linked.",
        agent_notes: [
          "Tell the customer you can't find an open account on their profile.",
          "Offer to transfer them to a specialist with escalate-to-human.",
        ],
      };
    }

    const fnParams: Record<string, unknown> = { account_id: auth.primary_account_id };
    if (input.days !== undefined) fnParams.days = input.days;
    if (input.merchant !== undefined) fnParams.merchant = input.merchant;
    if (input.category !== undefined) fnParams.category = input.category;
    if (input.status !== undefined) fnParams.status = input.status;
    if (input.limit !== undefined) fnParams.limit = input.limit;

    // callFn retries once internally and normalizes failures to { ok: false }.
    const res = await callFn(ctx, "transactions-search", fnParams);
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The transaction service is not responding right now.",
        agent_notes: [
          "Apologize briefly; do not retry again this turn.",
          "Offer a callback or to continue with something else.",
        ],
      };
    }
    const result = res.result;

    if (result && result.error) {
      return {
        error: result.error,
        message: result.message,
        agent_notes: result.agent_notes ?? [
          "The transaction search failed. Apologize and offer to escalate to a human specialist.",
        ],
      };
    }

    const agent_notes: string[] = [...(result.agent_notes ?? [])];
    if ((result.transactions ?? []).length === 0) {
      agent_notes.push(
        "No transactions matched. Say so and offer to widen the search (more days, no merchant filter)."
      );
    } else {
      agent_notes.push(
        "Summarize on voice: read at most 3-5 transactions (date, merchant, amount) and offer to continue or narrow down."
      );
    }

    await recordFact(ctx, {
      tool: "account-search-transactions",
      intent: "account/transaction_lookup",
    });

    return { ...result, agent_notes };
  },
});
