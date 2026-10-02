import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { loadCase, logCaseEvent } from "../_shared/pipeline";

/**
 * Platform-API adapter. Primary path: context.api (workspace-scoped service
 * account — the intended mechanism). Until a tenant service account exists,
 * falls back to the MCC_PLATFORM_API secret {api_key, base_url, workspace_id};
 * the fallback ALWAYS sends X-Workspace-Id — a key-only call would land in the
 * General workspace.
 */
async function platformApi(
  context: Context,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {}
): Promise<any> {
  try {
    if (method === "GET") return await context.api.get(path, { query: opts.query });
    if (method === "POST") return await context.api.post(path, { body: opts.body });
    if (method === "DELETE") return await context.api.del(path, { body: opts.body });
    return await context.api.put(path, { body: opts.body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not configured|must be a service account/i.test(msg)) {
      throw err;
    }
  }
  const raw: any = await context.secrets.get("MCC_PLATFORM_API");
  const cfg = typeof raw === "string" ? JSON.parse(raw) : raw?.value ? JSON.parse(raw.value) : raw;
  if (!cfg?.api_key || !cfg?.base_url || !cfg?.workspace_id) {
    throw new Error("platform API unavailable: no service account and MCC_PLATFORM_API secret is incomplete");
  }
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const res = await fetch(`${cfg.base_url}/api${path}${qs}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-api-key": cfg.api_key,
      "X-Workspace-Id": cfg.workspace_id
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`platform API ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 150)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Agent 2 → Campaign handoff. Queues customer outreach for a decided case by
 * creating ONE Campaign consumer with external_id = case_id (idempotent) and
 * only safe payload data (first name, outcome, required info). Never notifies
 * a blocked case. Re-notifies only when the outcome changed since the last
 * queued notification. Uses context.api (workspace-scoped service account) —
 * no API key handling. Degrades gracefully while the Campaign doesn't exist
 * yet (global MCC_DISPUTE_CAMPAIGN_ID unset → skipped_no_campaign).
 */
async function userFunction(context: Context) {
  const caseId = context.data.case_id;
  const taskId = context.data.task_id || null;
  if (!caseId) {
    return {
      error: "missing_parameter",
      message: "case_id is required.",
      agent_notes: ["Pass the case_id from the task payload."]
    };
  }

  const caseRow = await loadCase(context, caseId);
  if (!caseRow) {
    return { error: "case_not_found", message: `No dispute case ${caseId} exists.`, agent_notes: [] };
  }
  const c = caseRow.data;

  // Hard rule: a blocked case never produces outreach of any kind.
  if (c.case_state === "blocked" || c.outcome === "blocked") {
    return {
      error: "never_notify_blocked",
      message: "Blocked cases must never create a Campaign consumer or disclose the transaction.",
      agent_notes: ["End the task — no outreach for provenance failures."]
    };
  }
  if (!c.outcome || !["decided", "info_requested"].includes(c.case_state)) {
    return {
      error: "not_decided",
      message: `Case ${caseId} has no decided outcome to communicate (state: ${c.case_state}).`,
      agent_notes: ["Call case-decide first."]
    };
  }

  // Re-notify only on a changed outcome (Agent 3 re-notification rule).
  if (c.last_notified_outcome === c.outcome && c.notification_status === "queued") {
    return {
      already_queued: true,
      case_id: caseId,
      outcome: c.outcome,
      notification_status: c.notification_status,
      message: `Outreach for outcome ${c.outcome} is already queued — nothing to do.`,
      agent_notes: ["Idempotent no-op. Do not create another consumer."]
    };
  }

  let campaignId: string | null = null;
  try {
    const g = await context.globals.get("MCC_DISPUTE_CAMPAIGN_ID");
    campaignId = g ? String(g) : null;
  } catch {
    campaignId = null;
  }
  if (!campaignId) {
    await context.tables.update(T("disputes"), caseRow.id, { notification_status: "skipped_no_campaign" });
    await logCaseEvent(context, {
      case_id: caseId,
      task_id: taskId,
      actor: "agent2-backoffice",
      event_type: "notification_skipped",
      outcome: c.outcome,
      detail: "MCC_DISPUTE_CAMPAIGN_ID is not configured — outreach skipped until the Campaign exists."
    });
    return {
      case_id: caseId,
      notification_status: "skipped_no_campaign",
      message: "No Campaign configured; the decision stands and outreach was skipped.",
      agent_notes: ["Acceptable while Agent 3 is not deployed. End the task with the decision summary."]
    };
  }

  // Safe payload only: first name + phone from the customer record.
  const { rows: custRows } = await context.tables.filter(
    T("customers"),
    [{ column: "customer_id", operator: "eq", value: c.customer_id }],
    1,
    0
  );
  const customer = custRows.length > 0 ? custRows[0].data : null;
  if (!customer || !customer.phone) {
    await context.tables.update(T("disputes"), caseRow.id, { notification_status: "failed" });
    await logCaseEvent(context, {
      case_id: caseId,
      task_id: taskId,
      actor: "agent2-backoffice",
      event_type: "notification_failed",
      outcome: c.outcome,
      detail: "No phone number on file for the customer."
    });
    return {
      case_id: caseId,
      notification_status: "failed",
      message: "The customer has no phone number on file — outreach cannot be queued.",
      agent_notes: ["End the task noting the missing contact channel."]
    };
  }

  const consumerData: Record<string, unknown> = {
    case_id: caseId,
    outcome: c.outcome,
    first_name: customer.first_name,
    dispute_type: c.dispute_type,
    amount: c.amount,
    required_info: c.required_info || null,
    provisional_credit: c.provisional_credit === true,
    expected_credit_timing: c.outcome === "auto_approve" ? "2 business days" : null
  };

  try {
    // Idempotency: ONE consumer per phone number (campaign constraint,
    // verified live via 409). Look up by external_id first, then by phone —
    // an existing consumer for this customer is reused and re-pointed at the
    // newest case; call-briefing resolves the case by phone anyway.
    const byIdRes: any = await platformApi(context, "GET", `/v1/campaigns/${campaignId}/consumers`, {
      query: { external_id: caseId }
    });
    let existing = (byIdRes?.data?.items || byIdRes?.items || []).find((x: any) => x && x.external_id === caseId);
    if (!existing) {
      // The list response omits contacts — resolve a phone conflict by
      // scanning consumer details (small campaign; verified 409 otherwise).
      const allRes: any = await platformApi(context, "GET", `/v1/campaigns/${campaignId}/consumers`, {
        query: { limit: "200" }
      });
      const all: any[] = allRes?.data?.items || allRes?.items || [];
      const norm = (p: string) => String(p || "").replace(/\D/g, "").slice(-10);
      for (const cand of all) {
        try {
          const det: any = await platformApi(context, "GET", `/v1/campaigns/${campaignId}/consumers/${cand.id}`);
          const full = det?.data || det;
          if (
            Array.isArray(full?.contacts) &&
            full.contacts.some((ct: any) => norm(ct?.phone_number) === norm(customer.phone))
          ) {
            existing = full;
            break;
          }
        } catch {
          // skip unreadable consumers
        }
      }
      if (existing && (existing.status === "opted_out" || existing.opted_out_at)) {
        await context.tables.update(T("disputes"), caseRow.id, { notification_status: "skipped_opt_out" });
        await logCaseEvent(context, {
          case_id: caseId,
          task_id: taskId,
          actor: "agent2-backoffice",
          event_type: "notification_skipped",
          outcome: c.outcome,
          detail: "Customer opted out of campaign calls — no outreach."
        });
        return {
          case_id: caseId,
          notification_status: "skipped_opt_out",
          message: "The customer opted out of calls; no consumer was created.",
          agent_notes: ["Respect the opt-out. End the task with the decision summary."]
        };
      }
    }

    if (existing && c.last_notified_outcome === c.outcome) {
      await context.tables.update(T("disputes"), caseRow.id, { notification_status: "queued" });
      return {
        already_queued: true,
        case_id: caseId,
        consumer_id: existing.id,
        message: "Consumer already exists for this case and outcome.",
        agent_notes: ["Idempotent no-op."]
      };
    }

    let consumerId: string;
    if (existing) {
      // A consumer that already completed an attempt will NOT redial on a
      // re-point (verified live) — a NEW outcome needs a fresh consumer.
      // Same phone + same campaign, so delete-then-recreate is safe.
      await platformApi(context, "PUT", `/v1/campaigns/${campaignId}/consumers/${existing.id}`, {
        body: { external_id: caseId, data: consumerData }
      });
      consumerId = existing.id;
      if (c.last_notified_outcome && c.last_notified_outcome !== c.outcome) {
        try {
          await platformApi(context, "DELETE", `/v1/campaigns/${campaignId}/consumers/${existing.id}`);
          const recreated: any = await platformApi(context, "POST", `/v1/campaigns/${campaignId}/consumers`, {
            body: {
              name: customer.first_name,
              external_id: caseId,
              contacts: [{ phone_number: customer.phone }],
              data: consumerData
            }
          });
          consumerId = recreated?.data?.id || recreated?.id || consumerId;
        } catch (err) {
          console.error(`consumer recreate failed, keeping re-pointed consumer: ${err instanceof Error ? err.message : "unknown"}`);
        }
      }
    } else {
      const created: any = await platformApi(context, "POST", `/v1/campaigns/${campaignId}/consumers`, {
        body: {
          name: customer.first_name,
          external_id: caseId,
          contacts: [{ phone_number: customer.phone }],
          data: consumerData
        }
      });
      consumerId = created?.data?.id || created?.id || "unknown";
    }

    await context.tables.update(T("disputes"), caseRow.id, {
      notification_status: "queued",
      last_notified_outcome: c.outcome
    });
    await logCaseEvent(context, {
      case_id: caseId,
      task_id: taskId,
      actor: "agent2-backoffice",
      event_type: "notification_queued",
      outcome: c.outcome,
      detail: `Campaign consumer ${consumerId} (external_id=${caseId}) queued for outcome ${c.outcome}.`
    });

    // Pre-call heads-up SMS: once per case, before any outreach attempt.
    // Bank name + safe reason + window + never-ask warning; no case details,
    // no links. Delivery status is recorded in the audit trail.
    if (customer.sms_opt_in !== false && !c.precall_sms_sent) {
      try {
        await context.telephony.sendSms(
          customer.phone,
          `Meridian Card Services: we have an update on your recent dispute and will call you within 1 business day (9am-8pm ET). We will NEVER ask for your password, PIN, or one-time codes. Questions? Call the number on the back of your card.`,
          { senderId: "Meridian" }
        );
        await context.tables.update(T("disputes"), caseRow.id, { precall_sms_sent: true });
        await logCaseEvent(context, {
          case_id: caseId,
          task_id: taskId,
          actor: "agent2-backoffice",
          event_type: "precall_sms_sent",
          detail: "Pre-call heads-up SMS delivered (bank name, safe reason, call window, never-ask warning)."
        });
      } catch (err) {
        await logCaseEvent(context, {
          case_id: caseId,
          task_id: taskId,
          actor: "agent2-backoffice",
          event_type: "precall_sms_failed",
          detail: `SMS send failed: ${err instanceof Error ? err.message : "unknown"}`
        });
      }
    }
    return {
      case_id: caseId,
      consumer_id: consumerId,
      notification_status: "queued",
      outcome: c.outcome,
      agent_notes: ["Outreach queued. End the task with the resolution summary."]
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    await context.tables.update(T("disputes"), caseRow.id, { notification_status: "failed" });
    await logCaseEvent(context, {
      case_id: caseId,
      task_id: taskId,
      actor: "agent2-backoffice",
      event_type: "notification_failed",
      outcome: c.outcome,
      detail: `Campaign API error: ${detail}`
    });
    return {
      case_id: caseId,
      notification_status: "failed",
      error: "campaign_api_error",
      message: `Consumer creation failed: ${detail}`,
      agent_notes: ["The decision stands; outreach failed and is visible in the monitoring app for retry."]
    };
  }
}
