import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { addDaysIsoDate } from "../_shared/dates";

// Searches an account's transactions within a rolling day window, with
// optional merchant/category/status narrowing.
async function userFunction(context: Context) {
  const accountId = context.data.account_id;
  if (!accountId) {
    return {
      error: "missing_parameter",
      message: "account_id is required.",
      agent_notes: ["Call mcc-customers-lookup first to resolve the customer's account_id."]
    };
  }

  const days = Math.max(1, Number(context.data.days ?? 30));
  const limit = Math.min(Math.max(Number(context.data.limit ?? 10), 1), 100);
  const cutoff = addDaysIsoDate(-days);

  const filters: Array<{ column: string; operator: string; value?: unknown }> = [
    { column: "account_id", operator: "eq", value: accountId },
    { column: "date", operator: "gte", value: cutoff }
  ];
  if (context.data.merchant) {
    filters.push({ column: "merchant", operator: "contains", value: context.data.merchant });
  }
  if (context.data.category) {
    filters.push({ column: "category", operator: "eq", value: context.data.category });
  }
  if (context.data.status) {
    filters.push({ column: "status", operator: "eq", value: context.data.status });
  }

  const { rows, total } = await context.tables.filter(T("transactions"), filters, limit, 0, [
    { column: "date", direction: "desc" }
  ]);

  const agentNotes: string[] = [];
  if (total === 0) {
    agentNotes.push(
      `No transactions matched in the last ${days} days. Offer to widen the window or drop a filter.`
    );
  } else {
    agentNotes.push(
      `Showing ${rows.length} of ${total} matching transactions from the last ${days} days, newest first. Negative amounts are payments, refunds, or credits.`
    );
    if (total > rows.length) {
      agentNotes.push("More matches exist — offer to narrow by merchant, category, or a shorter window.");
    }
  }

  return {
    transactions: rows.map((r) => ({
      // transaction_id is a data-plane reference for downstream tools (dispute
      // filing) — the agent never reads it aloud.
      transaction_id: r.data.transaction_id,
      date: r.data.date,
      merchant: r.data.merchant,
      amount: r.data.amount,
      status: r.data.status,
      category: r.data.category
    })),
    total_found: total,
    agent_notes: agentNotes
  };
}

