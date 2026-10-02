import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

const VALID_STATUSES = ["pending", "approved", "denied"];

// PRIVATE dashboard endpoint: list review cases (optionally by status),
// oldest first so reviewers work the queue by age, plus status counts.
async function userFunction(context: Context) {
  const status = context.data.status;
  if (status && !VALID_STATUSES.includes(status)) {
    return {
      error: "invalid_status",
      message: `status must be one of: ${VALID_STATUSES.join(", ")}.`,
      agent_notes: ["Omit status to list every case."]
    };
  }

  const filters = status ? [{ column: "status", operator: "eq", value: status }] : [];
  const { rows } = await context.tables.filter(T("block_review_cases"), filters, 1000, 0, [
    { column: "submitted_at", direction: "asc" }
  ]);

  const [pending, approved, denied] = await Promise.all([
    context.tables.count(T("block_review_cases"), [{ column: "status", operator: "eq", value: "pending" }]),
    context.tables.count(T("block_review_cases"), [{ column: "status", operator: "eq", value: "approved" }]),
    context.tables.count(T("block_review_cases"), [{ column: "status", operator: "eq", value: "denied" }])
  ]);

  return {
    cases: rows.map((r) => r.data),
    counts: { pending, approved, denied }
  };
}

