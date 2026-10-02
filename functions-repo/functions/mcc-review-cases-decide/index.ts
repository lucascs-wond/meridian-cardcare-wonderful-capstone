import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowIso } from "../_shared/dates";

// PRIVATE dashboard endpoint: record a reviewer's decision on a pending
// case. Approval ALSO reactivates the card — this is the ONLY code path
// anywhere that unblocks a card (agent tools have no unblock write).
async function userFunction(context: Context) {
  const caseId = context.data.case_id;
  const decision = context.data.decision;
  const reviewer = context.data.reviewer;

  if (!caseId || !decision) {
    return {
      error: "missing_parameter",
      message: "case_id and decision are required.",
      agent_notes: ["Pick a case from mcc-review-cases-list and pass its case_id."]
    };
  }
  if (decision !== "approve" && decision !== "deny") {
    return {
      error: "invalid_decision",
      message: "decision must be \"approve\" or \"deny\".",
      agent_notes: ["Only approve and deny are valid decisions."]
    };
  }

  const { rows } = await context.tables.filter(
    T("block_review_cases"),
    [{ column: "case_id", operator: "eq", value: caseId }],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "case_not_found",
      message: "No review case matches that case_id.",
      agent_notes: ["Refresh the case list — the case_id did not match."]
    };
  }

  const reviewCase = rows[0].data;
  if (reviewCase.status !== "pending") {
    return {
      error: "case_already_decided",
      message: `Case ${caseId} is already ${reviewCase.status} (decision: ${reviewCase.decision}).`,
      agent_notes: ["Decisions are final — no update was made."]
    };
  }

  const decidedAt = nowIso();
  const newStatus = decision === "approve" ? "approved" : "denied";

  await context.tables.update(T("block_review_cases"), rows[0].id, {
    status: newStatus,
    decision,
    reviewer_notes: context.data.reviewer_notes ?? null,
    decided_at: decidedAt
  });
  // The reviewer identity is captured in the run log; the contract table
  // schema intentionally has no reviewer column.
  console.log(`review case ${caseId} ${decision} by ${reviewer ?? "unknown reviewer"}`);

  if (decision === "approve") {
    // The ONLY unblock write path in the whole system.
    const { rows: cardRows } = await context.tables.filter(
      T("cards"),
      [{ column: "card_id", operator: "eq", value: reviewCase.card_id }],
      1,
      0
    );
    if (cardRows.length > 0) {
      await context.tables.update(T("cards"), cardRows[0].id, {
        status: "active",
        block_reason: null
      });
    }
  }

  return {
    case_id: caseId,
    status: newStatus,
    decided_at: decidedAt
  };
}

