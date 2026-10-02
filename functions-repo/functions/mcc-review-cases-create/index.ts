import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowEpochMs, nowIso } from "../_shared/dates";
import { validateReviewToken } from "../_shared/review-platform";

// PUBLIC review-platform endpoint: files a card-unblock review case.
// No API key on the public path, so the shared token is validated first.
async function userFunction(context: Context) {
  const tokenCheck = validateReviewToken(context);
  if (!tokenCheck.ok) {
    return tokenCheck.result;
  }

  const { customer_id, card_id, card_last4, block_reason, customer_stated_reason, channel } = context.data;
  if (!customer_id || !card_id || !card_last4 || !block_reason || !customer_stated_reason || !channel) {
    return {
      error: "missing_parameter",
      message:
        "customer_id, card_id, card_last4, block_reason, customer_stated_reason, and channel are all required.",
      agent_notes: ["Collect the customer's stated reason for the unblock before filing the case."]
    };
  }

  // One pending case per card — return the existing case instead of a duplicate.
  const { rows: pendingRows } = await context.tables.filter(
    T("block_review_cases"),
    [
      { column: "card_id", operator: "eq", value: card_id },
      { column: "status", operator: "eq", value: "pending" }
    ],
    1,
    0
  );
  if (pendingRows.length > 0) {
    return {
      error: "case_already_pending",
      message: `A review case is already pending for this card: ${pendingRows[0].data.case_id}.`,
      case_id: pendingRows[0].data.case_id,
      agent_notes: [
        "Do not file a duplicate. Give the customer the existing case id and the 4-business-hour review SLA.",
        "Offer fraud-check-unblock-status if they want the current state of that case."
      ]
    };
  }

  const caseId = `BRC-${nowEpochMs()}`;
  await context.tables.insert(T("block_review_cases"), {
    case_id: caseId,
    customer_id,
    card_id,
    card_last4,
    block_reason,
    customer_stated_reason,
    status: "pending",
    decision: null,
    reviewer_notes: null,
    // Column is submitted_at by design — created_at/updated_at are platform-reserved.
    submitted_at: context.data.timestamp || nowIso(),
    decided_at: null,
    channel
  });

  // Kick off the deterministic HITL procedure ("MCC Unblock Case Flow"):
  // it parks on the reviewer's decision (durable table-condition wait), then
  // branches approve/deny and texts the customer the outcome. Fire-and-forget:
  // filing the case must never fail because the notification flow is down.
  // The automation id is workspace config, not code — global MCC_UNBLOCK_FLOW_ID.
  let flowRunId: string | null = null;
  try {
    const automationId = await context.globals.get("MCC_UNBLOCK_FLOW_ID");
    if (automationId) {
      const { runId } = await context.automations.invoke({
        automationId: String(automationId),
        input: { case_id: caseId, customer_id, card_last4 }
      });
      flowRunId = runId;
    }
  } catch (err) {
    console.error(
      `unblock-flow invoke failed (case still filed): ${err instanceof Error ? err.message : "unknown"}`
    );
  }

  return {
    case_id: caseId,
    status: "pending",
    flow_run_id: flowRunId,
    sla: "4 business hours",
    agent_notes: [
      `Case ${caseId} created. Tell the customer a specialist will review it within 4 business hours and we will text the decision.`,
      "Send the unblock_case_received SMS confirmation via send-sms-confirmation."
    ]
  };
}

