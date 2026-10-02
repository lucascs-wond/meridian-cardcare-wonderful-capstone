import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Surfaces the account's suspicious activity: fraud-flagged transactions,
// declined attempts, and pending foreign charges — plus the card status.
async function userFunction(context: Context) {
  const accountId = context.data.account_id;
  if (!accountId) {
    return {
      error: "missing_parameter",
      message: "account_id is required.",
      agent_notes: ["Call mcc-customers-lookup first to resolve the customer's account_id."]
    };
  }

  const base = { column: "account_id", operator: "eq", value: accountId };
  const [flaggedQ, declinedQ, foreignPendingQ] = await Promise.all([
    context.tables.filter(T("transactions"), [base, { column: "is_fraud_flagged", operator: "eq", value: true }], 100, 0),
    context.tables.filter(T("transactions"), [base, { column: "status", operator: "eq", value: "declined" }], 100, 0),
    // Seed convention: foreign activity carries a location starting with "Foreign".
    context.tables.filter(
      T("transactions"),
      [base, { column: "status", operator: "eq", value: "pending" }, { column: "location", operator: "contains", value: "Foreign" }],
      100,
      0
    )
  ]);

  // Merge the three signals, de-duplicated by transaction_id, newest first.
  const byId = new Map<string, Record<string, any>>();
  for (const row of [...flaggedQ.rows, ...declinedQ.rows, ...foreignPendingQ.rows]) {
    byId.set(row.data.transaction_id, row.data);
  }
  const flagged = [...byId.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((txn) => ({
      transaction_id: txn.transaction_id,
      date: txn.date,
      merchant: txn.merchant,
      amount: txn.amount,
      status: txn.status,
      location: txn.location
    }));

  const { rows: cardRows } = await context.tables.filter(
    T("cards"),
    [{ column: "account_id", operator: "eq", value: accountId }],
    100,
    0
  );
  // Report the most security-relevant card: fraud-flagged first, then blocked/lost, then any.
  const relevantCard =
    cardRows.find((r) => r.data.is_fraud_flagged) ??
    cardRows.find((r) => r.data.status !== "active") ??
    cardRows[0];
  const cardStatus = relevantCard ? relevantCard.data.status : "no_cards_on_file";

  const agentNotes: string[] = [];
  if (flagged.length === 0) {
    agentNotes.push("No suspicious activity found on this account. Reassure the customer.");
  } else {
    agentNotes.push(
      `${flagged.length} suspicious item(s) found. Read them back briefly; if the customer does not recognize them, offer to block the card and file a dispute.`
    );
    if (cardStatus === "blocked" || cardStatus === "reported_lost") {
      agentNotes.push(
        `The related card is already ${cardStatus} — do not offer another block; explain the existing protection instead.`
      );
    }
  }

  return {
    flagged,
    card_status: cardStatus,
    agent_notes: agentNotes
  };
}

