import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  return `${email[0]}***${email.slice(at)}`;
}

// Queues a statement copy for email delivery ("latest" or a YYYY-MM month).
async function userFunction(context: Context) {
  const accountId = context.data.account_id;
  const period = context.data.period ?? "latest";

  if (!accountId) {
    return {
      error: "missing_parameter",
      message: "account_id is required.",
      agent_notes: ["Call mcc-customers-lookup first to resolve the customer's account_id."]
    };
  }
  if (period !== "latest" && !/^\d{4}-\d{2}$/.test(String(period))) {
    return {
      error: "invalid_period",
      message: "period must be \"latest\" or a month in YYYY-MM format.",
      agent_notes: ["Ask which month the customer needs and pass it as YYYY-MM, or use \"latest\"."]
    };
  }

  const { rows } = await context.tables.filter(
    T("accounts"),
    [{ column: "account_id", operator: "eq", value: accountId }],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "account_not_found",
      message: "No account matches that account_id.",
      agent_notes: ["Re-check the account_id from the verified auth state before retrying."]
    };
  }

  const { rows: customerRows } = await context.tables.filter(
    T("customers"),
    [{ column: "customer_id", operator: "eq", value: rows[0].data.customer_id }],
    1,
    0
  );
  if (customerRows.length === 0) {
    return {
      error: "customer_not_found",
      message: "The account has no linked customer record.",
      agent_notes: ["Data inconsistency — apologize and escalate to a human specialist."]
    };
  }

  const emailMasked = maskEmail(String(customerRows[0].data.email ?? ""));
  const periodLabel = period === "latest" ? "the latest statement" : `the ${period} statement`;

  return {
    delivery: "email",
    email_masked: emailMasked,
    eta: "within 15 minutes",
    agent_notes: [
      `Confirm that ${periodLabel} will be emailed to ${emailMasked} within 15 minutes.`,
      "If the customer says that email is outdated, offer account-update-contact first, then re-request the statement."
    ]
  };
}

