import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({});

export default w.tool({
  name: "rewards-list-redemption-options",
  description:
    "Lists the redemption options available to the verified customer with per-option eligibility (minimum points, tier and product restrictions). Use when the customer asks what they can do with their points or before quoting a redemption.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    // callFn retries once internally and normalizes failures to { ok: false }.
    const res = await callFn(ctx, "redemption-options", {
      customer_id: auth.customer_id,
    });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The rewards service is not responding right now.",
        agent_notes: [
          "Apologize briefly; do not retry again this turn.",
          "Offer a callback or to continue with something else.",
        ],
      };
    }
    const result = res.result;

    if (result && result.error) {
      return {
        error: result.error,
        message: result.message,
        agent_notes: result.agent_notes ?? [
          "The redemption options lookup failed. Apologize and offer to escalate to a human specialist.",
        ],
      };
    }

    const options = result.options ?? [];
    const eligible = options.filter((o: any) => o.eligible !== false);
    const agent_notes: string[] = [...(result.agent_notes ?? [])];
    if (eligible.length === 0) {
      agent_notes.push(
        "No option is currently eligible. Explain the closest one (its minimum points) and how far the customer is from it."
      );
    } else {
      agent_notes.push(
        `On voice, read the ${eligible.length} eligible option names first and mention ineligible ones only if asked (with the reason).`,
        "When the customer picks one, quote it with rewards-redeem-points (option and points, no confirm flag yet)."
      );
    }

    await recordFact(ctx, {
      tool: "rewards-list-redemption-options",
      intent: "rewards/redemption_options",
    });

    return { ...result, agent_notes };
  },
});
