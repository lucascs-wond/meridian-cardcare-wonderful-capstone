import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({
  field: s
    .enum("phone", "email", "address")
    .describe("Which contact detail to update: phone, email, or address."),
  new_value: s
    .string()
    .sensitive()
    .describe(
      "The new value exactly as the customer stated it. Phone in E.164 if possible; address as a single line including city, state, and zip."
    ),
  confirmed: s
    .optional(s.boolean())
    .describe(
      "Leave unset on the first call. Pass true ONLY after you read the new value back to the customer and they explicitly confirmed it."
    ),
});

export default w.tool({
  name: "account-update-contact",
  description:
    "Updates the verified customer's phone, email, or mailing address. Two-step: the first call returns a read-back instruction; call again with confirmed: true only after the customer explicitly confirms the new value.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    // Step 1: no write yet — instruct the agent to read the value back first.
    if (input.confirmed !== true) {
      return {
        confirmation_required: true,
        field: input.field,
        new_value: input.new_value,
        agent_notes: [
          `Nothing was updated yet. Read the new ${input.field} back to the customer slowly and exactly, then ask them to confirm it is correct.`,
          "If they confirm, call account-update-contact again with the same field and new_value plus confirmed: true.",
          "If they correct any part, collect the full value again and start over without confirmed.",
        ],
      };
    }

    // callFn retries once internally and normalizes failures to { ok: false }.
    const res = await callFn(ctx, "contact-update", {
      customer_id: auth.customer_id,
      field: input.field,
      new_value: input.new_value,
    });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The profile service is not responding right now.",
        agent_notes: [
          "Apologize briefly; the contact detail was NOT updated. Do not retry again this turn.",
          "Offer a callback or suggest updating it in the app or website.",
        ],
      };
    }
    const result = res.result;

    if (result && result.error) {
      return {
        error: result.error,
        message: result.message,
        agent_notes: result.agent_notes ?? [
          "The update failed and nothing was changed. Apologize and offer to escalate to a human specialist.",
        ],
      };
    }

    const agent_notes: string[] = [...(result.agent_notes ?? [])];
    agent_notes.push(
      `Confirm to the customer that their ${result.updated_field} has been updated. Do not repeat the full new value again.`
    );

    await recordFact(ctx, {
      tool: "account-update-contact",
      intent: "account/contact_update",
      action: `contact_updated:${input.field}`,
    });

    return { ...result, agent_notes };
  },
});
