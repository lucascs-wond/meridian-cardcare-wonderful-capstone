import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { FN_PREFIX } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({});

// Data-plane call with one retry on transient failure; throws after the second failure.
async function runFn(ctx: Context, slug: string, fnParams: Record<string, unknown>) {
  try {
    const { result } = await ctx.functions.run({ slug, params: fnParams });
    return result;
  } catch (firstError) {
    const { result } = await ctx.functions.run({ slug, params: fnParams });
    return result;
  }
}

export default w.tool({
  name: "fraud-list-suspicious-activity",
  description:
    "Lists fraud-flagged, declined, and suspicious pending activity on the verified customer's account, plus the current card status. Use when the customer mentions charges they don't recognize.",
  params,
  handler: async (ctx, _input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    const accountId = auth.primary_account_id || (Array.isArray(auth.account_ids) ? auth.account_ids[0] : null);
    if (!accountId) {
      return {
        error: "account_not_found",
        message: "No account is linked to the verified session.",
        agent_notes: ["Verification did not record an account. Re-run verify-identity or escalate via escalate-to-human."],
      };
    }

    let result;
    try {
      result = await runFn(ctx, `${FN_PREFIX}suspicious-activity`, { account_id: accountId });
    } catch (e) {
      return {
        error: "service_unavailable",
        message: "Suspicious activity could not be retrieved right now.",
        agent_notes: [
          "Data lookup failed twice. Apologize; if the customer suspects active fraud, offer fraud-block-card or escalate-to-human immediately.",
        ],
      };
    }
    if (result && result.error) {
      return result;
    }

    const flagged = Array.isArray(result.flagged) ? result.flagged : [];

    await recordFact(ctx, {
      tool: "fraud-list-suspicious-activity",
      intent: "fraud/suspicious_activity",
      action: `suspicious_activity_reviewed:${flagged.length}`,
    });

    return {
      flagged_count: flagged.length,
      flagged,
      card_status: result.card_status ?? null,
      agent_notes:
        Array.isArray(result.agent_notes) && result.agent_notes.length > 0
          ? result.agent_notes
          : flagged.length === 0
            ? ["No suspicious activity was found. Reassure the customer and ask if a specific charge worried them (use account-search-transactions for general browsing)."]
            : [
                `Found ${flagged.length} suspicious item(s). Read them back one at a time (date, merchant, amount) and ask the customer to confirm or deny each.`,
                "If the customer does not recognize a charge, offer fraud-block-card and fraud-file-dispute.",
              ],
    };
  },
});
