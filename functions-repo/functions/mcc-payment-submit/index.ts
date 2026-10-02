import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { addDaysIsoDate, nowEpochMs, nowIso } from "../_shared/dates";

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// Submits a card payment from the bank account on file: validates the amount
// against the balance, blocks rapid duplicates, records the payment, and
// updates the account balances. The payment completes IN the conversation —
// this is Agent 1's synchronous journey, no pipeline involved.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  const accountId = context.data.account_id;
  const amount = Number(context.data.amount);

  if (!customerId || !accountId || !context.data.amount) {
    return {
      error: "missing_parameter",
      message: "customer_id, account_id, and amount are required.",
      agent_notes: ["Use the verified customer's ids from the auth state and confirm the amount first."]
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      error: "invalid_amount",
      message: "The payment amount must be a positive number.",
      agent_notes: ["Re-confirm the amount with the customer — dollars and cents, greater than zero."]
    };
  }

  const { rows } = await context.tables.filter(
    T("accounts"),
    [
      { column: "account_id", operator: "eq", value: accountId },
      { column: "customer_id", operator: "eq", value: customerId }
    ],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "account_not_found",
      message: "No account matches the verified customer.",
      agent_notes: ["Re-run verify-identity or escalate — do not retry with altered ids."]
    };
  }
  const accRow = rows[0];
  const acc = accRow.data;

  if (!acc.bank_account_last4) {
    return {
      error: "no_bank_on_file",
      message: "There is no bank account on file to pay from.",
      agent_notes: [
        "Explain we can only draw from a bank account already on file, and that adding one isn't possible on this call.",
        "Offer meridiancards.com or a specialist via escalate-to-human to set up a funding account."
      ]
    };
  }

  const balance = Number(acc.current_balance) || 0;
  if (amount > balance) {
    return {
      error: "amount_exceeds_balance",
      message: `The payment of $${amount.toFixed(2)} exceeds the current balance of $${balance.toFixed(2)}.`,
      current_balance: balance,
      agent_notes: [
        "We do not accept payments above the current balance. Offer to pay the full balance instead and confirm."
      ]
    };
  }

  // Duplicate guard: an identical amount on this account inside 10 minutes is
  // almost always a double-submit — confirm intent instead of double-drafting.
  const { rows: recent } = await context.tables.filter(
    T("payments"),
    [
      { column: "account_id", operator: "eq", value: accountId },
      { column: "amount", operator: "eq", value: amount }
    ],
    5,
    0
  );
  const now = nowEpochMs();
  const dup = recent.find((r) => {
    const ts = Date.parse(r.data.submitted_at || "");
    return Number.isFinite(ts) && now - ts < DUPLICATE_WINDOW_MS;
  });
  if (dup && context.data.allow_duplicate !== true) {
    return {
      error: "possible_duplicate",
      message: `A payment of $${amount.toFixed(2)} was already submitted minutes ago (confirmation ${dup.data.confirmation_number}).`,
      agent_notes: [
        "Tell the customer this amount was just paid and read the existing confirmation number.",
        "Only if they explicitly want a SECOND payment of the same amount, call again with allow_duplicate: true."
      ]
    };
  }

  const paymentId = `PAY-${now}`;
  const confirmation = `MC-${String(now).slice(-8)}`;
  const postDate = addDaysIsoDate(1);
  await context.tables.insert(T("payments"), {
    payment_id: paymentId,
    account_id: accountId,
    customer_id: customerId,
    amount,
    payment_method: "bank_account_on_file",
    bank_last4: acc.bank_account_last4,
    status: "scheduled",
    confirmation_number: confirmation,
    submitted_at: nowIso(),
    post_date: postDate
  });
  await context.tables.update(T("accounts"), accRow.id, {
    current_balance: Math.round((balance - amount) * 100) / 100,
    available_credit: Math.round(((Number(acc.available_credit) || 0) + amount) * 100) / 100,
    last_payment_amount: amount,
    last_payment_date: nowIso()
  });

  return {
    payment_id: paymentId,
    confirmation_number: confirmation,
    amount,
    bank_last4: acc.bank_account_last4,
    post_date: postDate,
    new_balance: Math.round((balance - amount) * 100) / 100,
    agent_notes: [
      `Payment of $${amount.toFixed(2)} from the bank account ending ${acc.bank_account_last4} is confirmed — read back the confirmation number ${confirmation}.`,
      `It posts by ${postDate}; the new balance is $${(balance - amount).toFixed(2)}.`
    ]
  };
}
