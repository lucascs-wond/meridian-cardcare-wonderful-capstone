import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Called by the "MCC Unblock Case Flow" procedure after the reviewer decides.
// Reads the case + customer from the tables (never hardcoded data), sends the
// unblock_decision SMS (wording mirrors the agent's shared/sms-templates.ts),
// and returns a flat, auditable result. All failures are returned, not thrown,
// so the procedure run records a clean step outcome either way.
//
// History note: the original implementation was clobbered by the function-
// registration scaffold commit the day it was written (2026-08-28) and every
// flow run since "succeeded" while sending nothing. Restored 2026-09-01 with
// three fixes: table rows are unwrapped via .data, the SMS send is awaited,
// and sms_opt_in follows the pipeline-wide default-opt-in semantics.
async function userFunction(context: Context) {
  const caseId = context.data.case_id;
  const decision = context.data.decision;

  if (!caseId || !decision) {
    return { error: "missing_parameter", message: "Provide case_id and decision." };
  }

  const { rows: caseRows } = await context.tables.filter(
    T("block_review_cases"),
    [{ column: "case_id", operator: "eq", value: caseId }],
    1,
    0
  );
  if (caseRows.length === 0) {
    return { error: "case_not_found", message: `No review case ${caseId}.` };
  }
  const reviewCase = caseRows[0].data;

  const { rows: custRows } = await context.tables.filter(
    T("customers"),
    [{ column: "customer_id", operator: "eq", value: reviewCase.customer_id }],
    1,
    0
  );
  if (custRows.length === 0) {
    return { error: "customer_not_found", message: `No customer ${reviewCase.customer_id}.` };
  }
  const customer = custRows[0].data;

  if (customer.sms_opt_in === false) {
    return {
      notified: false,
      reason: "sms_opt_out",
      case_id: caseId,
      decision,
      message: "Customer has opted out of SMS; no notification sent."
    };
  }

  const notesLine =
    decision === "approved"
      ? "Your card is active again."
      : reviewCase.reviewer_notes
        ? `Reviewer note: ${reviewCase.reviewer_notes}`
        : "Call us if you'd like to discuss the decision.";

  const message =
    `Meridian: Update on case ${caseId} — your card ending ${reviewCase.card_last4} ` +
    `unblock request was ${decision}. ${notesLine}`;

  try {
    await context.telephony.sendSms(customer.phone, message, { senderId: "Meridian" });
  } catch (err) {
    return {
      notified: false,
      error: "sms_send_failed",
      case_id: caseId,
      decision,
      message: `SMS send failed: ${err instanceof Error ? err.message : "unknown error"}`
    };
  }

  return { notified: true, channel: "sms", case_id: caseId, decision };
}
