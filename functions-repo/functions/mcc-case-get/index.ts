import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { daysSince } from "../_shared/dates";
import { loadCase } from "../_shared/pipeline";

const DISPUTE_WINDOW_DAYS = 60;
const SIBLING_WINDOW_DAYS = 3;

// Backoffice evidence bundle: the case, its transaction, sibling transactions
// (duplicate detection), card status, ownership re-validation, and derived
// flags the rulebook needs. Read-only — decisions go through mcc-case-decide.
async function userFunction(context: Context) {
  const caseId = context.data.case_id;
  if (!caseId) {
    return {
      error: "missing_parameter",
      message: "case_id is required.",
      agent_notes: ["Pass the case_id from the task payload."]
    };
  }

  const caseRow = await loadCase(context, caseId);
  if (!caseRow) {
    return {
      error: "case_not_found",
      message: `No dispute case ${caseId} exists.`,
      agent_notes: ["Decide blocked only if the task insists on acting on a nonexistent case; otherwise stop."]
    };
  }
  const c = caseRow.data;

  // Ownership re-validation: the transaction must belong to exactly this
  // customer + account. A mismatch is a provenance failure → blocked.
  let transaction: any = null;
  if (c.transaction_id) {
    const { rows: txnRows } = await context.tables.filter(
      T("transactions"),
      [{ column: "transaction_id", operator: "eq", value: c.transaction_id }],
      1,
      0
    );
    transaction = txnRows.length > 0 ? txnRows[0].data : null;
  }
  const ownershipOk =
    !!transaction && transaction.customer_id === c.customer_id && transaction.account_id === c.account_id;

  // Sibling transactions on the same account & merchant (±3 days) — the
  // duplicate-charge eligibility evidence.
  let siblings: any[] = [];
  if (transaction) {
    const { rows: sibRows } = await context.tables.filter(
      T("transactions"),
      [
        { column: "account_id", operator: "eq", value: c.account_id },
        { column: "merchant", operator: "eq", value: transaction.merchant }
      ],
      50,
      0
    );
    siblings = sibRows
      .map((r) => r.data)
      .filter(
        (t) =>
          t.transaction_id !== transaction.transaction_id &&
          Math.abs(daysSince(t.date) - daysSince(transaction.date)) <= SIBLING_WINDOW_DAYS
      )
      .map((t) => ({
        transaction_id: t.transaction_id,
        date: t.date,
        amount: t.amount,
        status: t.status,
        is_disputed: t.is_disputed
      }));
  }
  const hasSiblingSameAmount = !!transaction && siblings.some((s) => s.amount === transaction.amount);

  // Card status at decision time (fraud disputes: lost/stolen corroboration).
  let card: any = null;
  if (transaction && transaction.card_id) {
    const { rows: cardRows } = await context.tables.filter(
      T("cards"),
      [{ column: "card_id", operator: "eq", value: transaction.card_id }],
      1,
      0
    );
    card = cardRows.length > 0 ? cardRows[0].data : null;
  }

  const txnAgeDays = transaction ? daysSince(transaction.date) : null;
  const expectedDatePassed = c.expected_delivery_date ? daysSince(c.expected_delivery_date) > 0 : false;

  const flags = {
    ownership_ok: ownershipOk,
    window_expired: txnAgeDays !== null ? txnAgeDays > DISPUTE_WINDOW_DAYS : false,
    txn_age_days: txnAgeDays,
    has_sibling_same_amount: hasSiblingSameAmount,
    sibling_count: siblings.length,
    card_reported: !!card && (card.status === "blocked" || !!card.block_reason),
    card_fraud_flagged: !!card && !!card.is_fraud_flagged,
    txn_fraud_flagged: !!transaction && !!transaction.is_fraud_flagged,
    attestation_present: !!c.customer_stated_details,
    merchant_contacted: c.merchant_contacted === true,
    merchant_contact_recorded: c.merchant_contacted !== null && c.merchant_contacted !== undefined,
    expected_delivery_date_recorded: !!c.expected_delivery_date,
    expected_date_passed: expectedDatePassed,
    amount_mismatch_documented:
      c.stated_correct_amount !== null &&
      c.stated_correct_amount !== undefined &&
      !!transaction &&
      c.stated_correct_amount !== transaction.amount,
    already_resolved: c.status === "closed" || !!c.resolution || (!!transaction && transaction.status === "refunded"),
    reprocess: c.case_state === "info_received" || !!c.info_submitted
  };

  const agentNotes: string[] = [
    `Dispute type ${c.dispute_type}: apply that type's eligibility rule from the rulebook, then call case-decide exactly once.`
  ];
  if (!ownershipOk) {
    agentNotes.push("OWNERSHIP FAILED: the transaction does not belong to this customer/account — the only valid outcome is blocked.");
  }
  if (flags.already_resolved) {
    agentNotes.push("Case already resolved (merchant refund or prior resolution): close_resolved, with no new credit.");
  }
  if (flags.reprocess && c.info_submitted) {
    agentNotes.push("This is a reprocess after request_info — weigh the customer's submitted info below before deciding.");
  }

  return {
    case: {
      case_id: c.dispute_id,
      dispute_type: c.dispute_type,
      case_state: c.case_state,
      status: c.status,
      outcome: c.outcome || null,
      customer_id: c.customer_id,
      account_id: c.account_id,
      transaction_id: c.transaction_id,
      reason: c.reason,
      amount: c.amount,
      filed_at: c.filed_at,
      provisional_credit: c.provisional_credit === true,
      customer_stated_details: c.customer_stated_details || null,
      merchant_contacted: c.merchant_contacted ?? null,
      expected_delivery_date: c.expected_delivery_date || null,
      stated_correct_amount: c.stated_correct_amount ?? null,
      required_info: c.required_info || null,
      info_submitted: c.info_submitted || null,
      resolution: c.resolution || null
    },
    transaction: transaction
      ? {
          transaction_id: transaction.transaction_id,
          date: transaction.date,
          merchant: transaction.merchant,
          category: transaction.category,
          amount: transaction.amount,
          currency: transaction.currency,
          status: transaction.status,
          type: transaction.type,
          location: transaction.location,
          is_fraud_flagged: !!transaction.is_fraud_flagged
        }
      : null,
    siblings,
    card: card
      ? { last4: card.last4, status: card.status, block_reason: card.block_reason || null, is_fraud_flagged: !!card.is_fraud_flagged }
      : null,
    flags,
    agent_notes: agentNotes
  };
}
