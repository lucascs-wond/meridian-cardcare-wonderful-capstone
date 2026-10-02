import { s, w } from "@wonderful/types/schema";
import { recordFact } from "../../shared/auth-state";

/**
 * Warm handoff to a human specialist (contracts §5, architecture §10 triggers).
 * The destination number comes from the HANDOFF secret {"phone": "+1..."}.
 * If forwarding is unavailable (off-hours, secret missing, provider error)
 * the tool returns the alternatives branch instead of failing silently.
 */

const params = s.object({
  reason: s
    .string()
    .describe(
      "Short reason for the transfer, e.g. 'verification lockout', 'customer asked for a human', 'tool outage'."
    ),
});

const ALTERNATIVES_NOTES = [
  "Transfer to a specialist is not available right now.",
  "Offer a callback Monday to Saturday, 8 AM to 10 PM Eastern, or an SMS recap of this conversation via send-sms-confirmation.",
];

export default w.tool({
  name: "escalate-to-human",
  description:
    "Transfers the caller to a human specialist. Call when the customer asks for a human, " +
    "after a verification lockout, when a tool keeps failing after retry, on fraud distress, " +
    "or after an abuse warning. Announce the transfer before the line switches.",
  params,
  handler: async (ctx, input) => {
    await recordFact(ctx, {
      tool: "escalate-to-human",
      action: `escalation_requested: ${input.reason}`,
      outcome: "escalated",
      escalated: true,
    });

    // Resolve the handoff number from the HANDOFF secret (never hardcoded).
    let phone: string | null = null;
    try {
      const raw: unknown = ctx.secrets.get("HANDOFF");
      const parsed: any = typeof raw === "string" ? JSON.parse(raw) : raw;
      phone = parsed?.phone ? String(parsed.phone) : null;
    } catch {
      phone = null;
    }
    if (!phone) {
      return {
        transferred: false,
        alternatives_offered: true,
        agent_notes: ALTERNATIVES_NOTES,
      };
    }

    try {
      // Announce first — the session ends once the forward goes through.
      ctx.agent.forceAnnounce(
        "I'm connecting you with a specialist now. Please stay on the line."
      );
      await ctx.session.forward(phone);
      return {
        transferred: true,
        agent_notes: [
          "The call is being transferred to a human specialist. Do not say anything further.",
        ],
      };
    } catch (err: any) {
      console.error(`escalate-to-human forward failed: ${err?.message ?? err}`);
      return {
        transferred: false,
        alternatives_offered: true,
        agent_notes: ALTERNATIVES_NOTES,
      };
    }
  },
});
