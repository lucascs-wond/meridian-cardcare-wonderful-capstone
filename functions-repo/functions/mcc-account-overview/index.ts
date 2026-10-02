import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Returns the balance/payment overview for one account, with status-specific
// agent_notes phrasing for the credit_balance and past_due_over_limit edges.
async function userFunction(context: Context) {
  const accountId = context.data.account_id;
  if (!accountId) {
    return {
      error: "missing_parameter",
      message: "account_id is required.",
      agent_notes: ["Call mcc-customers-lookup first to resolve the customer's account_id."]
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

  const account = rows[0].data;

  const { rows: productRows } = await context.tables.filter(
    T("card_products"),
    [{ column: "product_id", operator: "eq", value: account.product_id }],
    1,
    0
  );
  const productName = productRows.length > 0 ? productRows[0].data.name : account.product_id;

  const agentNotes: string[] = [];
  if (account.status === "credit_balance") {
    agentNotes.push(
      "This balance is a credit — we owe the customer money. Present the amount as a credit in their favor and make clear no payment is due."
    );
  } else if (account.status === "past_due_over_limit") {
    agentNotes.push(
      "Account is past due AND over its credit limit. Be empathetic and non-judgmental: calmly state the minimum payment and due date, offer payment options, and never lecture or assign blame."
    );
  } else if (account.status === "closed") {
    agentNotes.push("This account is closed. Share historical information only; new charges are not possible.");
  } else {
    agentNotes.push(
      "Lead with the current balance; offer the payment due date and minimum payment only if the caller wants them."
    );
  }

  return {
    account_id: account.account_id,
    product_name: productName,
    current_balance: account.current_balance,
    available_credit: account.available_credit,
    credit_limit: account.credit_limit,
    statement_balance: account.statement_balance,
    min_payment_due: account.min_payment_due,
    payment_due_date: account.payment_due_date,
    autopay_enrolled: account.autopay_enrolled,
    autopay_type: account.autopay_type,
    status: account.status,
    agent_notes: agentNotes
  };
}

