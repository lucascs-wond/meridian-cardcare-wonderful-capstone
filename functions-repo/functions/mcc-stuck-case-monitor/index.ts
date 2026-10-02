import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowEpochMs, nowIso } from "../_shared/dates";

const STUCK_AFTER_HOURS: Record<string, number> = {
  received: 1, // a webhook task should claim within minutes
  processing: 2, // a decision task should finish within minutes
  info_received: 2, // the reprocess webhook should have fired
  decided: 48 // outreach should complete within the campaign's attempt window
};

const OPERATOR_EMAIL = "ops-alerts@example.com";

// Time-to-resolution targets (filed_at -> decided_at, hours).
const TTR_TARGET_H = 24;
const TTR_CONCERN_H = 48;

/**
 * The pipeline's stuck-case alert (scheduled hourly). Deterministic rules:
 * a case is stuck when it sits in a working state past its budget, or its
 * notification failed. Each stuck case gets ONE audit event per calendar day
 * (no alert storms) and the operator gets one summary email per run that
 * found anything.
 */
async function userFunction(context: Context) {
  const now = nowEpochMs();
  const stuck: Array<{ case_id: string; state: string; reason: string; age_h: number }> = [];

  for (const [state, budgetH] of Object.entries(STUCK_AFTER_HOURS)) {
    const { rows } = await context.tables.filter(
      T("disputes"),
      [{ column: "case_state", operator: "eq", value: state }],
      100,
      0
    );
    for (const r of rows) {
      const c = r.data;
      if (String(c.dispute_id).startsWith("EVL-")) continue; // eval fixtures
      const ref = Date.parse(c.decided_at || c.filed_at || "");
      if (!Number.isFinite(ref)) continue;
      const ageH = (now - ref) / 3600000;
      if (state === "decided" && !["queued", "delivered"].includes(c.notification_status || "")) {
        if (c.notification_status === "failed") {
          stuck.push({ case_id: c.dispute_id, state, reason: "notification failed", age_h: Math.round(ageH) });
          continue;
        }
      }
      if (ageH > budgetH) {
        stuck.push({
          case_id: c.dispute_id,
          state,
          reason: `in ${state} for ${Math.round(ageH)}h (budget ${budgetH}h)`,
          age_h: Math.round(ageH)
        });
      }
    }
  }

  // Pipeline health: time-to-resolution (filed -> closed) over closed cases,
  // measured against the named targets above. One pipeline_health event per day.
  const { rows: closedRows } = await context.tables.filter(
    T("disputes"),
    [{ column: "case_state", operator: "eq", value: "closed" }],
    100,
    0
  );
  const ttrs: number[] = [];
  for (const r of closedRows) {
    const c = r.data;
    if (String(c.dispute_id).startsWith("EVL-")) continue;
    const filed = Date.parse(c.filed_at || "");
    if (!Number.isFinite(filed)) continue;
    // Close time = the case's last audit event (the close is always audited).
    const { rows: evts } = await context.tables.filter(
      T("case_events"),
      [{ column: "case_id", operator: "eq", value: c.dispute_id }],
      50,
      0
    );
    let closedAt = NaN;
    for (const e of evts) {
      const t = Date.parse(e.data.logged_at || "");
      if (Number.isFinite(t) && (!Number.isFinite(closedAt) || t > closedAt)) closedAt = t;
    }
    if (!Number.isFinite(closedAt) || closedAt <= filed) continue;
    ttrs.push((closedAt - filed) / 3600000);
  }
  ttrs.sort((a, b) => a - b);
  const medianTtr = ttrs.length > 0 ? ttrs[Math.floor((ttrs.length - 1) / 2)] : null;
  const health = {
    closed_cases: ttrs.length,
    median_ttr_h: medianTtr === null ? null : Math.round(medianTtr * 100) / 100,
    max_ttr_h: ttrs.length > 0 ? Math.round(ttrs[ttrs.length - 1] * 100) / 100 : null,
    ttr_target_h: TTR_TARGET_H,
    ttr_concern_h: TTR_CONCERN_H,
    ttr_breached: medianTtr !== null && medianTtr > TTR_CONCERN_H
  };

  // One audit event per case per day.
  const today = nowIso().slice(0, 10);
  const { rows: healthEvents } = await context.tables.filter(
    T("case_events"),
    [
      { column: "case_id", operator: "eq", value: "PIPELINE-HEALTH" },
      { column: "event_type", operator: "eq", value: "pipeline_health" }
    ],
    10,
    0
  );
  if (!healthEvents.some((e) => String(e.data.logged_at || "").slice(0, 10) === today)) {
    await context.tables.insert(T("case_events"), {
      event_id: `EVT-${nowEpochMs()}-health`,
      case_id: "PIPELINE-HEALTH",
      actor: "system",
      event_type: "pipeline_health",
      detail: `TTR filed->closed over ${health.closed_cases} closed case(s): median ${health.median_ttr_h ?? "n/a"}h, max ${health.max_ttr_h ?? "n/a"}h (target ${TTR_TARGET_H}h, concern ${TTR_CONCERN_H}h)${health.ttr_breached ? " — CONCERN BREACHED" : ""}`,
      logged_at: nowIso()
    });
  }
  const alerted: string[] = [];
  for (const s of stuck) {
    const { rows: events } = await context.tables.filter(
      T("case_events"),
      [
        { column: "case_id", operator: "eq", value: s.case_id },
        { column: "event_type", operator: "eq", value: "stuck_case_alert" }
      ],
      10,
      0
    );
    if (events.some((e) => String(e.data.logged_at || "").slice(0, 10) === today)) continue;
    await context.tables.insert(T("case_events"), {
      event_id: `EVT-${nowEpochMs()}-stuck-${s.case_id}`,
      case_id: s.case_id,
      actor: "system",
      event_type: "stuck_case_alert",
      detail: s.reason,
      logged_at: nowIso()
    });
    alerted.push(`${s.case_id}: ${s.reason}`);
  }

  if (alerted.length > 0 || health.ttr_breached) {
    const lines = [...alerted];
    if (health.ttr_breached) {
      lines.push(`Time-to-resolution CONCERN: median ${health.median_ttr_h}h over ${health.closed_cases} closed case(s) exceeds ${TTR_CONCERN_H}h.`);
    }
    try {
      await context.email.send(
        OPERATOR_EMAIL,
        `[MCC pipeline] ${lines.length} pipeline alert(s)`,
        `The pipeline monitor flagged:\n\n${lines.join("\n")}\n\nSee the Review Desk → Dispute pipeline tab for state and audit trails.`
      );
    } catch (err) {
      console.error(`stuck-case email failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return { checked_at: nowIso(), stuck_count: stuck.length, alerted, health };
}
