import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Returns a customer's disputes — one by id, or all of them newest first.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  const disputeId = context.data.dispute_id;

  if (!customerId) {
    return {
      error: "missing_parameter",
      message: "customer_id is required.",
      agent_notes: ["Use the verified customer_id from the auth state."]
    };
  }

  const filters = [{ column: "customer_id", operator: "eq", value: customerId }];
  if (disputeId) {
    filters.push({ column: "dispute_id", operator: "eq", value: disputeId });
  }

  const { rows } = await context.tables.filter(T("disputes"), filters, 100, 0, [
    { column: "filed_at", direction: "desc" }
  ]);

  if (rows.length === 0 && disputeId) {
    return {
      error: "dispute_not_found",
      message: "No dispute with that id exists for this customer.",
      agent_notes: ["Confirm the dispute id, or call again without dispute_id to list all disputes."]
    };
  }

  const disputes = rows.map((r) => ({
    dispute_id: r.data.dispute_id,
    status: r.data.status,
    amount: r.data.amount,
    filed_at: r.data.filed_at,
    expected_resolution_date: r.data.expected_resolution_date,
    resolution: r.data.resolution,
    case_state: r.data.case_state || null,
    outcome: r.data.outcome || null,
    required_info: r.data.required_info || null,
    provisional_credit: r.data.provisional_credit === true,
    notification_status: r.data.notification_status || null
  }));

  const agentNotes: string[] = [];
  if (disputes.length === 0) {
    agentNotes.push("No disputes on file for this customer.");
  } else {
    if (disputes.some((d) => d.case_state === "info_requested")) {
      const waiting = disputes.find((d) => d.case_state === "info_requested");
      agentNotes.push(
        `Case ${waiting.dispute_id} is waiting on the customer: ${waiting.required_info}. If they can provide it now, collect it and submit via the info-submit path; the review resumes automatically.`
      );
    }
    if (disputes.some((d) => d.case_state === "decided" && d.outcome === "auto_approve")) {
      agentNotes.push(
        "An approved dispute carries a provisional credit posting within 2 business days — share that outcome."
      );
    }
    if (disputes.some((d) => d.case_state === "received" || d.case_state === "processing")) {
      agentNotes.push("Cases in received/processing are still under review — the customer will be called with the outcome.");
    }
    const open = disputes.filter((d) => d.status === "open" || d.status === "under_review").length;
    const resolved = disputes.length - open;
    agentNotes.push(
      `${disputes.length} dispute(s) on file: ${open} in progress, ${resolved} resolved. Summarize status and expected resolution dates.`
    );
    if (disputes.some((d) => d.status === "resolved_merchant_favor")) {
      agentNotes.push(
        "At least one dispute resolved in the merchant's favor — deliver that outcome empathetically and explain any reversal of provisional credit."
      );
    }
  }

  return {
    disputes,
    agent_notes: agentNotes
  };
}

