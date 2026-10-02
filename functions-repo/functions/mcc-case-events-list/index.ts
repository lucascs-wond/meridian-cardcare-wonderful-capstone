import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { loadCase } from "../_shared/pipeline";

/**
 * Traceability read for the monitoring app and pipeline verification:
 * one case's full audit trail by case_id, or a pipeline overview with
 * per-state counts. Read-only.
 */
async function userFunction(context: Context) {
  const caseId = context.data.case_id;

  if (caseId) {
    const caseRow = await loadCase(context, caseId);
    if (!caseRow) {
      return { error: "case_not_found", message: `No dispute case ${caseId} exists.` };
    }
    const { rows } = await context.tables.filter(
      T("case_events"),
      [{ column: "case_id", operator: "eq", value: caseId }],
      200,
      0,
      [{ column: "logged_at", direction: "asc" }]
    );
    const { rows: attemptRows } = await context.tables.filter(
      T("campaign_attempts"),
      [{ column: "case_id", operator: "eq", value: caseId }],
      50,
      0,
      [{ column: "logged_at", direction: "asc" }]
    );
    const c = caseRow.data;
    return {
      case: {
        case_id: c.dispute_id,
        dispute_type: c.dispute_type,
        case_state: c.case_state,
        status: c.status,
        outcome: c.outcome || null,
        outcome_rationale: c.outcome_rationale || null,
        rule_applied: c.rule_applied || null,
        required_info: c.required_info || null,
        provisional_credit: c.provisional_credit === true,
        notification_status: c.notification_status || "none",
        decided_at: c.decided_at || null,
        decision_task_id: c.decision_task_id || null,
        filed_at: c.filed_at
      },
      events: rows.map((r) => r.data),
      attempts: attemptRows.map((r) => r.data)
    };
  }

  const state = context.data.case_state;
  const filters = state ? [{ column: "case_state", operator: "eq", value: state }] : [];
  const { rows } = await context.tables.filter(T("disputes"), filters, 100, 0, [
    { column: "filed_at", direction: "desc" }
  ]);
  const cases = rows
    .map((r) => r.data)
    .filter((c) => !!c.case_state)
    .map((c) => ({
      case_id: c.dispute_id,
      dispute_type: c.dispute_type,
      case_state: c.case_state,
      outcome: c.outcome || null,
      notification_status: c.notification_status || "none",
      filed_at: c.filed_at,
      decided_at: c.decided_at || null
    }));
  const counts: Record<string, number> = {};
  for (const c of cases) {
    counts[c.case_state] = (counts[c.case_state] || 0) + 1;
  }
  return { cases, counts_by_state: counts };
}
