import type { Context } from "@wonderful/types";
import { T } from "./tables";
import { nowEpochMs, nowIso } from "./dates";

/**
 * Dispute pipeline contracts shared by intake (mcc-dispute-create), the
 * backoffice decision path (mcc-case-*), and the Agent 3 info loop.
 * One case_id (= dispute_id) keys every table row, task, and consumer.
 */

export const OUTCOMES = ["auto_approve", "auto_reject", "request_info", "close_resolved", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

// Terminal pipeline states — a decide call on any of these is a replay and must no-op.
export const TERMINAL_STATES = ["decided", "closed", "blocked"];

// intake reason → rulebook dispute type
export function deriveDisputeType(reason: string): string {
  switch (reason) {
    case "unauthorized_transaction":
      return "fraud_unauthorized";
    case "goods_not_received":
    case "subscription_cancellation":
      return "goods_not_received";
    case "duplicate_charge":
    case "incorrect_amount":
      return "duplicate_or_incorrect";
    default:
      return "unknown";
  }
}

let eventCounter = 0;

/**
 * Audit-trail writer (mcc_case_events). Every pipeline action records one
 * event; an audit failure is logged but never fails the business action.
 */
export async function logCaseEvent(
  context: Context,
  evt: {
    case_id: string;
    task_id?: string | null;
    actor: string;
    event_type: string;
    from_state?: string | null;
    to_state?: string | null;
    outcome?: string | null;
    rule_applied?: string | null;
    detail?: string | null;
  }
): Promise<string | null> {
  eventCounter += 1;
  const eventId = `EVT-${nowEpochMs()}-${eventCounter}`;
  try {
    await context.tables.insert(T("case_events"), {
      event_id: eventId,
      case_id: evt.case_id,
      task_id: evt.task_id || null,
      actor: evt.actor,
      event_type: evt.event_type,
      from_state: evt.from_state || null,
      to_state: evt.to_state || null,
      outcome: evt.outcome || null,
      rule_applied: evt.rule_applied || null,
      detail: evt.detail || null,
      logged_at: nowIso()
    });
    return eventId;
  } catch (err) {
    console.error(`case_events insert failed for ${evt.case_id}: ${err instanceof Error ? err.message : "unknown"}`);
    return null;
  }
}

/**
 * Agent 1 → Agent 2 handoff: fires the backoffice webhook trigger that creates
 * one task per case event. Authenticated with the trigger's webhook secret
 * (X-Webhook-Secret) read from tenant secret MCC_BACKOFFICE_WEBHOOK — shape
 * {"trigger_url": "...", "secret": "..."} (object secret, or a JSON string).
 * Fire-and-forget by contract: callers must never fail the business action on
 * a webhook failure; duplicate deliveries are absorbed by mcc-case-decide's
 * state checks, so replays cannot repeat an internal action.
 */
export async function fireBackofficeWebhook(
  context: Context,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; detail: string }> {
  let cfg: { trigger_url?: string; secret?: string } = {};
  try {
    const raw: any = await context.secrets.get("MCC_BACKOFFICE_WEBHOOK");
    if (raw && typeof raw === "object") {
      cfg = raw;
    } else if (typeof raw === "string") {
      try {
        cfg = JSON.parse(raw);
      } catch {
        cfg = {};
      }
    }
  } catch (err) {
    return { ok: false, detail: `secret_unavailable: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!cfg.trigger_url || !cfg.secret) {
    return { ok: false, detail: "webhook_not_configured" };
  }
  try {
    const res = await fetch(cfg.trigger_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": cfg.secret
      },
      body: JSON.stringify(payload)
    });
    const body = await res.text();
    return { ok: res.ok, detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, detail: `fetch_failed: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

/** Loads a case row (dispute) by case_id. Returns null when absent. */
export async function loadCase(context: Context, caseId: string) {
  const { rows } = await context.tables.filter(
    T("disputes"),
    [{ column: "dispute_id", operator: "eq", value: caseId }],
    1,
    0
  );
  return rows.length > 0 ? rows[0] : null;
}
