import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowIso } from "../_shared/dates";
import { loadCase, logCaseEvent } from "../_shared/pipeline";

const BUSINESS_CODES = [
  "completed",
  "request_info_collected",
  "callback_requested",
  "bad_time",
  "wrong_number",
  "do_not_call"
] as const;

// Terminal outcomes: once communicated, the case closes.
const CLOSES_CASE = new Set(["auto_approve", "auto_reject", "close_resolved"]);

/**
 * Agent 3 disposition write: upserts exactly one row per attempt (attempt_id
 * is the idempotency key — a retry of the same call cannot create a second
 * record or a second business code), mirrors the outcome onto the case's
 * notification_status, and closes the case when a terminal outcome was
 * successfully communicated. Campaign retry/stop/opt-out routing happens via
 * the business-code call tag the disposition TOOL attaches; this function is
 * the durable record.
 */
async function userFunction(context: Context) {
  const attemptId = context.data.attempt_id;
  const caseId = context.data.case_id;
  const businessCode = context.data.business_code;
  if (!attemptId || !caseId || !businessCode) {
    return {
      error: "missing_parameter",
      message: "attempt_id, case_id, and business_code are required.",
      agent_notes: ["Record exactly one business code before the call ends."]
    };
  }
  if (!BUSINESS_CODES.includes(businessCode)) {
    return {
      error: "invalid_business_code",
      message: `business_code must be one of: ${BUSINESS_CODES.join(", ")}.`,
      agent_notes: ["Use exactly one approved business code."]
    };
  }

  const caseRow = await loadCase(context, caseId);
  if (!caseRow) {
    return { error: "case_not_found", message: `No dispute case ${caseId} exists.`, agent_notes: [] };
  }
  const c = caseRow.data;

  // Idempotent upsert by attempt_id; one business code per attempt, ever.
  const { rows: existing } = await context.tables.filter(
    T("campaign_attempts"),
    [{ column: "attempt_id", operator: "eq", value: attemptId }],
    1,
    0
  );
  if (existing.length > 0 && existing[0].data.business_code && existing[0].data.business_code !== businessCode) {
    return {
      error: "already_recorded",
      message: `Attempt ${attemptId} already recorded business code ${existing[0].data.business_code}.`,
      agent_notes: ["Exactly one business code per answered call — do not overwrite it."]
    };
  }

  const { rows: prior } = await context.tables.filter(
    T("campaign_attempts"),
    [{ column: "case_id", operator: "eq", value: caseId }],
    50,
    0
  );
  const record = {
    attempt_id: attemptId,
    case_id: caseId,
    consumer_external_id: caseId,
    attempt_number:
      existing.length > 0
        ? existing[0].data.attempt_number
        : prior.filter((r) => r.data.attempt_id !== attemptId).length + 1,
    technical_outcome: context.data.technical_outcome || "answered",
    business_code: businessCode,
    summary: context.data.summary || null,
    retry_action: context.data.retry_action || null,
    next_attempt_at: context.data.next_attempt_at || null,
    logged_at: nowIso()
  };
  if (existing.length > 0) {
    await context.tables.update(T("campaign_attempts"), existing[0].id, record);
  } else {
    await context.tables.insert(T("campaign_attempts"), record);
  }

  // Mirror the disposition onto the case.
  const update: Record<string, unknown> = {};
  if (businessCode === "completed") {
    update.notification_status = "delivered";
    if (CLOSES_CASE.has(c.outcome)) {
      update.case_state = "closed";
      update.status = "closed";
    }
  } else if (businessCode === "do_not_call") {
    update.notification_status = "opted_out";
  } else if (businessCode === "wrong_number") {
    update.notification_status = "failed";
  }
  if (Object.keys(update).length > 0) {
    await context.tables.update(T("disputes"), caseRow.id, update);
  }

  await logCaseEvent(context, {
    case_id: caseId,
    actor: "agent3-outbound",
    event_type: "outreach_disposition",
    outcome: c.outcome,
    to_state: (update.case_state as string) || null,
    detail: `Attempt ${record.attempt_number}: ${businessCode}${context.data.summary ? ` — ${context.data.summary}` : ""}`
  });

  return {
    attempt_id: attemptId,
    attempt_number: record.attempt_number,
    business_code: businessCode,
    case_state: (update.case_state as string) || c.case_state,
    notification_status: (update.notification_status as string) || c.notification_status,
    agent_notes: [
      businessCode === "completed"
        ? "Disposition recorded — the outcome was communicated; the case is settled."
        : `Disposition ${businessCode} recorded — the campaign's rules take it from here.`
    ]
  };
}
