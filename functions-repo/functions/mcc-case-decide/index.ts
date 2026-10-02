import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { daysSince, nowIso } from "../_shared/dates";
import { OUTCOMES, TERMINAL_STATES, loadCase, logCaseEvent } from "../_shared/pipeline";

// THE decision gate of the dispute pipeline. Every hard rule the rulebook
// states is enforced here — state transitions, ownership, evidence guards,
// idempotency — so a prompt mistake or a replayed task can never repeat an
// internal action or produce an invalid decision.
async function userFunction(context: Context) {
  const caseId = context.data.case_id;
  const outcome = context.data.outcome;
  const rationale = context.data.rationale;
  const ruleApplied = context.data.rule_applied;
  const requiredInfo = context.data.required_info;
  const taskId = context.data.task_id || null;

  if (!caseId || !outcome || !rationale) {
    return {
      error: "missing_parameter",
      message: "case_id, outcome, and rationale are required.",
      agent_notes: ["Every decision must carry its rationale — it is written to the audit trail."]
    };
  }
  if (!OUTCOMES.includes(outcome)) {
    return {
      error: "invalid_outcome",
      message: `outcome must be one of: ${OUTCOMES.join(", ")}.`,
      agent_notes: ["Use exactly one of the five rulebook outcomes."]
    };
  }
  if (outcome === "request_info" && !requiredInfo) {
    return {
      error: "missing_parameter",
      message: "request_info requires required_info describing exactly what the customer must provide.",
      agent_notes: ["Name the specific missing or conflicting item — Agent 3 reads this to the customer."]
    };
  }

  const caseRow = await loadCase(context, caseId);
  if (!caseRow) {
    return {
      error: "case_not_found",
      message: `No dispute case ${caseId} exists.`,
      agent_notes: ["Nothing to decide. End the task reporting the bad reference."]
    };
  }
  const c = caseRow.data;

  // Replay guard: a decided/closed/blocked case never accepts another
  // decision. Duplicate webhook deliveries and re-run tasks land here.
  if (TERMINAL_STATES.includes(c.case_state)) {
    return {
      already_decided: true,
      case_id: caseId,
      outcome: c.outcome,
      case_state: c.case_state,
      message: `Case ${caseId} was already decided (${c.outcome}). No action taken.`,
      agent_notes: [
        "Idempotent no-op: do NOT repeat internal actions and do NOT queue another notification.",
        "End the task summarizing the existing decision."
      ]
    };
  }

  // While the case waits on the customer, only a provenance failure may
  // override; everything else must go through the info-received path.
  if (c.case_state === "info_requested" && outcome !== "blocked") {
    return {
      error: "awaiting_customer_info",
      message: `Case ${caseId} is waiting on the customer (${c.required_info}). It reprocesses when the info arrives.`,
      agent_notes: ["End the task — the request_info outreach is already queued."]
    };
  }

  // Ownership re-validation (cross-account mismatch → blocked, and nothing else).
  let ownershipOk = false;
  if (c.transaction_id) {
    const { rows } = await context.tables.filter(
      T("transactions"),
      [
        { column: "transaction_id", operator: "eq", value: c.transaction_id },
        { column: "account_id", operator: "eq", value: c.account_id },
        { column: "customer_id", operator: "eq", value: c.customer_id }
      ],
      1,
      0
    );
    ownershipOk = rows.length > 0;
  }
  if (!ownershipOk && outcome !== "blocked") {
    return {
      error: "ownership_violation",
      message: "The disputed transaction does not belong to this customer/account. The only valid outcome is blocked.",
      agent_notes: ["Refuse to read or write another account's data. Decide blocked with the provenance rationale."]
    };
  }

  // Evidence guards: missing evidence can never justify a rejection.
  if (outcome === "auto_reject") {
    if (c.dispute_type === "goods_not_received" && (c.merchant_contacted === null || c.merchant_contacted === undefined)) {
      return {
        error: "must_request_info",
        message: "Merchant-contact evidence was never recorded — that is missing evidence, not grounds for rejection.",
        agent_notes: ["Rulebook: never deny only because evidence is missing. Decide request_info naming the merchant-contact evidence."]
      };
    }
    if (c.dispute_type === "fraud_unauthorized" && !c.customer_stated_details) {
      return {
        error: "must_request_info",
        message: "No customer attestation is on file — that is missing evidence, not grounds for rejection.",
        agent_notes: ["Decide request_info asking for the customer's attestation of the unauthorized charge."]
      };
    }
  }

  // Window guard: past the 60-day filing window nothing may be approved.
  if (outcome === "auto_approve" && c.filed_at && c.transaction_id) {
    const { rows: txnRows } = await context.tables.filter(
      T("transactions"),
      [{ column: "transaction_id", operator: "eq", value: c.transaction_id }],
      1,
      0
    );
    if (txnRows.length > 0) {
      if (daysSince(txnRows[0].data.date) > 60) {
        return {
          error: "window_expired",
          message: "The transaction is outside the 60-day dispute window — approval is not permitted.",
          agent_notes: ["Decide auto_reject citing the filing window, or request_info if dates conflict."]
        };
      }
    }
  }

  const fromState = c.case_state;
  const previousOutcome = c.outcome || null;
  const update: Record<string, unknown> = {
    outcome,
    outcome_rationale: rationale,
    rule_applied: ruleApplied || null,
    decided_at: nowIso(),
    decision_task_id: taskId,
    previous_outcome: previousOutcome
  };

  // Internal action — provisional credit — exactly once per case, ever.
  let creditIssued = false;
  if (
    outcome === "auto_approve" &&
    (c.dispute_type === "fraud_unauthorized" || c.dispute_type === "duplicate_or_incorrect") &&
    c.provisional_credit !== true
  ) {
    update.provisional_credit = true;
    creditIssued = true;
  }

  if (outcome === "request_info") {
    update.case_state = "info_requested";
    update.required_info = requiredInfo;
  } else if (outcome === "blocked") {
    update.case_state = "blocked";
    update.status = "blocked";
  } else if (outcome === "close_resolved") {
    update.case_state = "decided";
    update.status = "closed";
    update.resolution = c.resolution || "already_resolved";
  } else {
    // auto_approve / auto_reject: decided, open until the customer is notified.
    update.case_state = "decided";
    update.resolution = outcome === "auto_approve" ? "approved_provisional_credit" : "rejected";
  }

  await context.tables.update(T("disputes"), caseRow.id, update);

  await logCaseEvent(context, {
    case_id: caseId,
    task_id: taskId,
    actor: "agent2-backoffice",
    event_type: "decision",
    from_state: fromState,
    to_state: String(update.case_state),
    outcome,
    rule_applied: ruleApplied || null,
    detail: rationale
  });
  if (creditIssued) {
    await logCaseEvent(context, {
      case_id: caseId,
      task_id: taskId,
      actor: "agent2-backoffice",
      event_type: "internal_action",
      outcome,
      detail: `Provisional credit issued for ${c.amount} (posts within 2 business days).`
    });
  }

  const agentNotes: string[] = [`Decision recorded: ${outcome} (${fromState} → ${update.case_state}).`];
  if (outcome === "blocked") {
    agentNotes.push("NEVER notify a blocked case — do not call case-notify. End the task with the provenance summary.");
  } else {
    agentNotes.push("Now call case-notify to queue the customer outreach for this outcome.");
  }
  if (creditIssued) {
    agentNotes.push("Provisional credit was issued by this decision — mention the 2-business-day posting in the resolution summary.");
  }

  return {
    case_id: caseId,
    outcome,
    case_state: update.case_state,
    provisional_credit: c.provisional_credit === true || creditIssued,
    credit_issued_now: creditIssued,
    previous_outcome: previousOutcome,
    agent_notes: agentNotes
  };
}
