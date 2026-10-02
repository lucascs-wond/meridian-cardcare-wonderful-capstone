import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Maps the updatable contact field to its customers-table column. A single
// "address" string lands in address_line1 (city/state/zip stay unchanged).
const FIELD_COLUMN: Record<string, string> = {
  phone: "phone",
  email: "email",
  address: "address_line1"
};

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  return `${email[0]}***${email.slice(at)}`;
}

// Updates one contact field (phone, email, or address) on the customer row.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  const field = context.data.field;
  const newValue = context.data.new_value;

  if (!customerId || !field || !newValue) {
    return {
      error: "missing_parameter",
      message: "customer_id, field, and new_value are required.",
      agent_notes: ["Collect the new value and read it back to the customer before calling again."]
    };
  }
  if (!FIELD_COLUMN[field]) {
    return {
      error: "invalid_field",
      message: "field must be one of: phone, email, address.",
      agent_notes: ["Only phone, email, and mailing address can be updated on this call."]
    };
  }

  const { rows } = await context.tables.filter(
    T("customers"),
    [{ column: "customer_id", operator: "eq", value: customerId }],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "customer_not_found",
      message: "No customer matches that customer_id.",
      agent_notes: ["Re-check the customer_id from the verified auth state before retrying."]
    };
  }

  await context.tables.update(T("customers"), rows[0].id, {
    [FIELD_COLUMN[field]]: newValue
  });

  let confirmation: string;
  if (field === "phone") {
    confirmation = `Phone number on file now ends in ${String(newValue).slice(-4)}.`;
  } else if (field === "email") {
    confirmation = `Email on file is now ${maskEmail(String(newValue))}.`;
  } else {
    confirmation = "Mailing address updated.";
  }

  const agentNotes: string[] = [
    "Change saved. Speak the confirmation back to the customer without reading full contact details aloud."
  ];
  if (field === "address") {
    agentNotes.push(
      "The full address string was stored as the street line; city, state, and zip stay unchanged unless updated separately."
    );
  }

  return {
    updated_field: field,
    confirmation,
    agent_notes: agentNotes
  };
}

