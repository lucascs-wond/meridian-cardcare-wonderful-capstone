import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({});

export default w.tool({
  name: "account-get-overview",
  description:
    "Reads the verified customer's account overview: current balance, available credit, credit limit, statement balance, minimum payment, due date, and autopay status. Use for any 'how much do I owe / what's my balance / when is my payment due' question.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    if (!auth.primary_account_id) {
      return {
        error: "no_account_on_file",
        message: "The verified customer has no open account linked.",
        agent_notes: [
          "Tell the customer you can't find an open account on their profile.",
          "Offer to transfer them to a specialist with escalate-to-human.",
        ],
      };
    }

    // callFn retries once internally and normalizes failures to { ok: false }.
    const res = await callFn(ctx, "account-overview", {
      account_id: auth.primary_account_id,
    });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The account service is not responding right now.",
        agent_notes: [
          "Apologize briefly; do not retry again this turn.",
          "Offer a callback or to continue with something else, e.g. general card questions.",
        ],
      };
    }
    const overview = res.result;

    if (overview && overview.error) {
      return {
        error: overview.error,
        message: overview.message,
        agent_notes: overview.agent_notes ?? [
          "The account lookup failed. Apologize and offer to escalate to a human specialist.",
        ],
      };
    }

    const agent_notes: string[] = [...(overview.agent_notes ?? [])];
    const accountIds = auth.account_ids ?? [];
    if (accountIds.length > 1) {
      agent_notes.push(
        `Customer has ${accountIds.length} accounts (${accountIds.join(", ")}); this overview is for the primary account ${auth.primary_account_id}. Mention that and ask if they meant a different account.`
      );
    }
    agent_notes.push(
      "Answer only what was asked (e.g. just the balance) in 1-2 sentences; offer more detail instead of reading everything."
    );

    await recordFact(ctx, {
      tool: "account-get-overview",
      intent: "account/balance_inquiry",
    });

    return { ...overview, agent_notes };
  },
});
