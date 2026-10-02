import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({});

export default w.tool({
  name: "rewards-get-summary",
  description:
    "Reads the verified customer's rewards summary: points balance, pending points, tier, expiring points, and lifetime points. Use for 'how many points do I have' or tier/expiry questions about THIS customer. For general rewards-program rules, answer from card knowledge instead.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    // callFn retries once internally and normalizes failures to { ok: false }.
    const res = await callFn(ctx, "rewards-summary", {
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
    const summary = res.result;

    if (summary && summary.error) {
      return {
        error: summary.error,
        message: summary.message,
        agent_notes: summary.agent_notes ?? [
          "The rewards lookup failed. Apologize and offer to escalate to a human specialist.",
        ],
      };
    }

    const agent_notes: string[] = [...(summary.agent_notes ?? [])];
    if ((summary.points_expiring_next_90d ?? 0) > 0) {
      agent_notes.push(
        `Proactively mention that ${summary.points_expiring_next_90d} points expire within 90 days and offer redemption options.`
      );
    }
    agent_notes.push(
      "Lead with the points balance in one short sentence; offer tier and expiry details rather than reading everything."
    );

    await recordFact(ctx, {
      tool: "rewards-get-summary",
      intent: "rewards/balance_inquiry",
    });

    return { ...summary, agent_notes };
  },
});
