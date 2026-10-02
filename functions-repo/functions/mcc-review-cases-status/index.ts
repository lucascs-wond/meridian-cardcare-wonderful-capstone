import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { validateReviewToken } from "../_shared/review-platform";

// PUBLIC review-platform endpoint (GET): status of one unblock review case,
// by case_id or the customer's most recent case. Token arrives as a query
// param and is validated before any read.
async function userFunction(context: Context) {
  const tokenCheck = validateReviewToken(context);
  if (!tokenCheck.ok) {
    return tokenCheck.result;
  }

  const caseId = context.data.case_id;
  const customerId = context.data.customer_id;
  if (!caseId && !customerId) {
    return {
      error: "missing_parameter",
      message: "Provide case_id or customer_id.",
      agent_notes: ["Use the case id from the unblock_case KV state, or fall back to the verified customer_id."]
    };
  }

  const filters = caseId
    ? [{ column: "case_id", operator: "eq", value: caseId }]
    : [{ column: "customer_id", operator: "eq", value: customerId }];

  // Most recent case first when looking up by customer.
  const { rows } = await context.tables.filter(T("block_review_cases"), filters, 1, 0, [
    { column: "submitted_at", direction: "desc" }
  ]);
  if (rows.length === 0) {
    return {
      error: "case_not_found",
      message: caseId
        ? "No review case matches that case_id."
        : "No review cases on file for this customer.",
      agent_notes: ["Confirm the case id with the customer, or offer to file a new unblock request."]
    };
  }

  const reviewCase = rows[0].data;

  const agentNotes: string[] = [];
  if (reviewCase.status === "pending") {
    agentNotes.push(
      "The case is still under review — remind the customer of the 4-business-hour SLA from submission and that we will text the decision."
    );
  } else if (reviewCase.decision === "approve") {
    agentNotes.push(
      `Approved — the card ending ${reviewCase.card_last4} has been unblocked and is active again. Share this good news.`
    );
  } else {
    agentNotes.push(
      "The request was denied. Deliver the decision empathetically, share the reviewer notes if present, and offer to escalate to a specialist."
    );
  }

  return {
    case_id: reviewCase.case_id,
    status: reviewCase.status,
    decision: reviewCase.decision,
    reviewer_notes: reviewCase.reviewer_notes,
    decided_at: reviewCase.decided_at,
    agent_notes: agentNotes
  };
}

