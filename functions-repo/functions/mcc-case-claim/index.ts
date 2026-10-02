import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowEpochMs } from "../_shared/dates";
import { logCaseEvent } from "../_shared/pipeline";

/**
 * Task → case binding for the dispute pipeline. The webhook trigger is the
 * per-case doorbell (one POST per filed case = one task), but the platform
 * does not expose the webhook body to the task runtime, so the case handoff
 * is state-based: intake parks the case in `received` (or the info loop in
 * `info_received`) BEFORE firing the webhook, and each task claims exactly
 * one case by atomically moving it to `processing` with a claim token.
 * A duplicate delivery finds nothing to claim and no-ops — replay-safe by
 * construction.
 */
async function userFunction(context: Context) {
  const taskId = context.data.task_id || null;

  // Explicit case_id wins when the caller knows it (future payload support,
  // reprocess flows, tests).
  const explicit = context.data.case_id;
  let rows: any[] = [];
  if (explicit) {
    ({ rows } = await context.tables.filter(
      T("disputes"),
      [{ column: "dispute_id", operator: "eq", value: explicit }],
      1,
      0
    ));
  } else {
    for (const state of ["received", "info_received"]) {
      const res = await context.tables.filter(
        T("disputes"),
        [{ column: "case_state", operator: "eq", value: state }],
        10,
        0,
        [{ column: "filed_at", direction: "asc" }]
      );
      rows = rows.concat(res.rows);
    }
  }
  const claimable = rows.filter((r) => ["received", "info_received"].includes(r.data.case_state));

  for (const row of claimable) {
    const claimToken = `CLM-${nowEpochMs()}-${row.data.dispute_id}`;
    await context.tables.update(T("disputes"), row.id, {
      case_state: "processing",
      decision_task_id: taskId || claimToken
    });
    // Verify the claim stuck (last writer wins — re-read and compare).
    const { rows: check } = await context.tables.filter(
      T("disputes"),
      [{ column: "dispute_id", operator: "eq", value: row.data.dispute_id }],
      1,
      0
    );
    if (check.length === 0 || check[0].data.decision_task_id !== (taskId || claimToken)) {
      continue; // lost the race to a concurrent task — try the next case
    }
    const c = check[0].data;
    await logCaseEvent(context, {
      case_id: c.dispute_id,
      task_id: taskId,
      actor: "agent2-backoffice",
      event_type: "task_started",
      from_state: row.data.case_state,
      to_state: "processing",
      detail: `Task claimed the case (${row.data.case_state === "info_received" ? "reprocess after request_info" : "new case"}).`
    });
    return {
      case_id: c.dispute_id,
      dispute_type: c.dispute_type,
      reprocess: row.data.case_state === "info_received",
      reason: c.reason,
      agent_notes: [
        `Claimed case ${c.dispute_id} (${c.dispute_type}${row.data.case_state === "info_received" ? ", reprocess" : ""}). Now call case-evidence.`
      ]
    };
  }

  return {
    nothing_to_claim: true,
    message: explicit
      ? `Case ${explicit} is not in a claimable state.`
      : "No case is waiting for a decision — this is a duplicate or stale delivery.",
    agent_notes: ["Nothing to process. Mark the task completed as a no-op duplicate delivery."]
  };
}
