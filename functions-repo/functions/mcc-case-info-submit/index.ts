import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowIso } from "../_shared/dates";
import { fireBackofficeWebhook, loadCase, logCaseEvent } from "../_shared/pipeline";

/**
 * Agent 3 → Agent 2 loop. Records information the customer supplied for a
 * case in info_requested, moves it to info_received, and fires the backoffice
 * webhook again so a NEW task reprocesses the SAME case_id. Also usable by
 * Agent 1 if a customer calls in with the requested information.
 */
async function userFunction(context: Context) {
  const caseId = context.data.case_id;
  const info = context.data.info;
  const source = context.data.source || "unspecified";
  if (!caseId || !info) {
    return {
      error: "missing_parameter",
      message: "case_id and info are required.",
      agent_notes: ["Pass the case id and the customer's answer to the required_info question."]
    };
  }

  const caseRow = await loadCase(context, caseId);
  if (!caseRow) {
    return { error: "case_not_found", message: `No dispute case ${caseId} exists.`, agent_notes: [] };
  }
  const c = caseRow.data;

  if (c.case_state !== "info_requested") {
    return {
      error: "invalid_state",
      message: `Case ${caseId} is not waiting for information (state: ${c.case_state}).`,
      agent_notes: [
        c.case_state === "info_received"
          ? "The info was already submitted and the case is reprocessing — do not submit again."
          : "Only cases in info_requested accept submissions."
      ]
    };
  }

  const stamped = `[${nowIso()} via ${source}] ${info}`;
  const infoSubmitted = c.info_submitted ? `${c.info_submitted}\n${stamped}` : stamped;
  await context.tables.update(T("disputes"), caseRow.id, {
    info_submitted: infoSubmitted,
    case_state: "info_received"
  });
  await logCaseEvent(context, {
    case_id: caseId,
    actor: source === "agent3-call" ? "agent3-outbound" : "agent1-inbound",
    event_type: "info_received",
    from_state: "info_requested",
    to_state: "info_received",
    detail: stamped
  });

  // Same contract as intake: one webhook → one new task for the same case_id.
  const hook = await fireBackofficeWebhook(context, {
    case_id: caseId,
    dispute_type: c.dispute_type,
    customer_id: c.customer_id,
    reason: c.reason,
    reprocess: true
  });
  await logCaseEvent(context, {
    case_id: caseId,
    actor: "system",
    event_type: hook.ok ? "reprocess_task_triggered" : "reprocess_trigger_failed",
    detail: hook.detail
  });

  return {
    case_id: caseId,
    case_state: "info_received",
    reprocess_triggered: hook.ok,
    agent_notes: [
      "Information recorded — the case reprocesses automatically.",
      hook.ok
        ? "Tell the customer the review resumes now and they will hear back with the outcome."
        : "The reprocess trigger failed; the case will be picked up by the stuck-case monitor."
    ]
  };
}
