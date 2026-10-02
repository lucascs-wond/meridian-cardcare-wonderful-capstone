import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Looks up a customer by phone or customer_id and returns the profile plus
// account/card summaries. verification_pin and date_of_birth are consumed by
// the verify-identity tool only — tools never surface them to the model.

// Callers say phone numbers in many formats ("555-010-0101", "(555) 010 0101").
// Tables store E.164 (+15550100101). Normalize to digits and build candidate
// forms so the model never has to format the value (tool-design rule).
function phoneCandidates(raw: string): string[] {
  const digits = String(raw).replace(/\D/g, "");
  const forms = new Set<string>([String(raw).trim()]);
  if (digits.length === 10) forms.add(`+1${digits}`);
  if (digits.length === 11 && digits.startsWith("1")) forms.add(`+${digits}`);
  if (digits.length >= 10) forms.add(`+${digits}`);
  return [...forms];
}

async function userFunction(context: Context) {
  const phone = context.data.phone;
  const customerId = context.data.customer_id;

  if (!phone && !customerId) {
    return {
      error: "missing_parameter",
      message: "Provide phone or customer_id.",
      agent_notes: ["Ask the caller for the phone number on the account, then retry the lookup."]
    };
  }

  let rows: any[] = [];
  if (customerId) {
    ({ rows } = await context.tables.filter(
      T("customers"),
      [{ column: "customer_id", operator: "eq", value: customerId }],
      1,
      0
    ));
  } else {
    for (const candidate of phoneCandidates(phone)) {
      ({ rows } = await context.tables.filter(
        T("customers"),
        [{ column: "phone", operator: "eq", value: candidate }],
        1,
        0
      ));
      if (rows.length > 0) break;
    }
  }
  if (rows.length === 0) {
    return {
      error: "customer_not_found",
      message: "No customer matches that phone number or customer id.",
      agent_notes: [
        "No match found. Confirm the phone number digit by digit and retry, or use the DOB fallback path in verify-identity."
      ]
    };
  }

  const customer = rows[0].data;

  const { rows: accountRows } = await context.tables.filter(
    T("accounts"),
    [{ column: "customer_id", operator: "eq", value: customer.customer_id }],
    100,
    0
  );

  // Resolve product display names in one query.
  const productIds = [...new Set(accountRows.map((r) => r.data.product_id))];
  const productNames: Record<string, string> = {};
  if (productIds.length > 0) {
    const { rows: productRows } = await context.tables.filter(
      T("card_products"),
      [{ column: "product_id", operator: "in", value: productIds }],
      100,
      0
    );
    for (const row of productRows) {
      productNames[row.data.product_id] = row.data.name;
    }
  }

  const { rows: cardRows } = await context.tables.filter(
    T("cards"),
    [{ column: "customer_id", operator: "eq", value: customer.customer_id }],
    100,
    0
  );

  return {
    customer_id: customer.customer_id,
    first_name: customer.first_name,
    last_name: customer.last_name,
    date_of_birth: customer.date_of_birth,
    verification_pin: customer.verification_pin,
    preferred_language: customer.preferred_language,
    sms_opt_in: customer.sms_opt_in,
    status: customer.status,
    phone: customer.phone,
    email: customer.email,
    accounts: accountRows.map((r) => ({
      account_id: r.data.account_id,
      product_id: r.data.product_id,
      product_name: productNames[r.data.product_id] ?? r.data.product_id
    })),
    cards: cardRows.map((r) => ({
      card_id: r.data.card_id,
      last4: r.data.last4,
      status: r.data.status,
      block_reason: r.data.block_reason,
      card_type: r.data.card_type,
      expiry: r.data.expiry
    })),
    agent_notes: [
      "verification_pin and date_of_birth are for in-tool comparison only — never reveal or read them to the caller."
    ]
  };
}

