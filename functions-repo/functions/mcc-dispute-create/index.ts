import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { addDaysIsoDate, daysSince, nowEpochMs, nowIso } from "../_shared/dates";
import { deriveDisputeType, fireBackofficeWebhook, logCaseEvent } from "../_shared/pipeline";

const VALID_REASONS = [
  "unauthorized_transaction",
  "duplicate_charge",
  "goods_not_received",
  "incorrect_amount",
  "subscription_cancellation"
];

const DISPUTE_WINDOW_DAYS = 60;
const RESOLUTION_DAYS = 45;

// Files a dispute case: enforces the 60-day window, marks the transaction
// disputed, inserts the case row, and hands off to the backoffice pipeline
// (Agent 2) via the authenticated webhook. Intake only — provisional credit
// is an Agent 2 decision (auto_approve), not a filing side effect.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  const accountId = context.data.account_id;
  const transactionId = context.data.transaction_id;
  const reason = context.data.reason;

  if (!customerId || !accountId || !transactionId || !reason) {
    return {
      error: "missing_parameter",
      message: "customer_id, account_id, transaction_id, and reason are required.",
      agent_notes: ["Locate the exact transaction via mcc-transactions-search before filing."]
    };
  }
  if (!VALID_REASONS.includes(reason)) {
    return {
      error: "invalid_reason",
      message: `reason must be one of: ${VALID_REASONS.join(", ")}.`,
      agent_notes: ["Map the customer's description to one of the five dispute reasons and retry."]
    };
  }

  const { rows } = await context.tables.filter(
    T("transactions"),
    [
      { column: "transaction_id", operator: "eq", value: transactionId },
      { column: "account_id", operator: "eq", value: accountId },
      { column: "customer_id", operator: "eq", value: customerId }
    ],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "transaction_not_found",
      message: "No transaction matches that id on this customer's account.",
      agent_notes: ["Re-find the transaction with mcc-transactions-search and confirm the merchant and amount."]
    };
  }

  const txn = rows[0].data;
  if (txn.is_disputed) {
    return {
      error: "already_disputed",
      message: `Transaction ${transactionId} already has an open dispute.`,
      agent_notes: ["Do not file twice — check mcc-dispute-status and give the customer the existing case status."]
    };
  }

  const age = daysSince(txn.date);
  if (age > DISPUTE_WINDOW_DAYS) {
    return {
      error: "dispute_window_expired",
      message: `This transaction posted ${age} days ago — past the ${DISPUTE_WINDOW_DAYS}-day dispute window.`,
      agent_notes: [
        "Explain the 60-day dispute policy empathetically and do not file the dispute.",
        "Offer alternatives: contact the merchant directly, or escalate to a specialist for exceptional review."
      ]
    };
  }

  const expectedResolutionDate = addDaysIsoDate(RESOLUTION_DAYS);
  const disputeId = `DSP-${nowEpochMs()}`;
  const disputeType = deriveDisputeType(reason);

  await context.tables.update(T("transactions"), rows[0].id, { is_disputed: true });
  await context.tables.insert(T("disputes"), {
    dispute_id: disputeId,
    customer_id: customerId,
    account_id: accountId,
    transaction_id: transactionId,
    reason,
    status: "open",
    amount: txn.amount,
    filed_at: nowIso(),
    // Credit is granted by the backoffice decision (auto_approve), never at filing.
    provisional_credit: false,
    resolution: null,
    expected_resolution_date: expectedResolutionDate,
    dispute_type: disputeType,
    case_state: "received",
    notification_status: "none",
    customer_stated_details: context.data.customer_stated_details || null,
    merchant_contacted:
      context.data.merchant_contacted === true ? true : context.data.merchant_contacted === false ? false : null,
    expected_delivery_date: context.data.expected_delivery_date || null,
    stated_correct_amount:
      context.data.stated_correct_amount !== undefined && context.data.stated_correct_amount !== null
        ? Number(context.data.stated_correct_amount)
        : null
  });
  await logCaseEvent(context, {
    case_id: disputeId,
    actor: "agent1-inbound",
    event_type: "case_filed",
    to_state: "received",
    detail: `${disputeType} dispute on ${txn.merchant} ${txn.amount} ${txn.currency} (${reason}) via ${context.data.channel || "voice"}.`
  });

  // Agent 1 → Agent 2 handoff: one authenticated webhook per filed case.
  // Fire-and-forget — intake never fails because the pipeline is down, and a
  // duplicate delivery is absorbed by mcc-case-decide's replay guard.
  const hook = await fireBackofficeWebhook(context, {
    case_id: disputeId,
    dispute_type: disputeType,
    customer_id: customerId,
    reason
  });
  await logCaseEvent(context, {
    case_id: disputeId,
    actor: "system",
    event_type: hook.ok ? "backoffice_task_triggered" : "backoffice_trigger_failed",
    detail: hook.detail
  });

  const agentNotes: string[] = [
    `Dispute case ${disputeId} filed for ${txn.merchant} (${txn.amount} ${txn.currency}). Give the customer the case id.`,
    "Do NOT promise a provisional credit — a specialist system reviews the case and credit is part of that decision.",
    "Tell the customer we will text a heads-up and then call them with the outcome, usually within 1 business day."
  ];
  if (reason === "unauthorized_transaction" && !context.data.customer_stated_details) {
    agentNotes.push(
      "No attestation was captured — the review will likely come back asking for it. Next time collect the customer's own words BEFORE filing and pass customer_stated_details."
    );
  }

  return {
    dispute_id: disputeId,
    case_id: disputeId,
    dispute_type: disputeType,
    case_state: "received",
    backoffice_triggered: hook.ok,
    expected_resolution_date: expectedResolutionDate,
    agent_notes: agentNotes
  };
}

