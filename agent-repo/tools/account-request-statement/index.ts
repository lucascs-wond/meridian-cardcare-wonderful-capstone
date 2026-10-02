import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";

const params = s.object({
  period: s
    .optional(s.string())
    .describe(
      "Which statement to send: 'latest' (default) for the most recent statement, or a specific month as YYYY-MM, e.g. 2026-06."
    ),
});

export default w.tool({
  name: "account-request-statement",
  description:
    "Sends a copy of the verified customer's account statement to their email on file. Use when the customer asks for a statement, a copy of their bill, or last month's statement.",
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
    const res = await callFn(ctx, "statement-request", {
      account_id: auth.primary_account_id,
      period: input.period ?? "latest",
    });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The statement service is not responding right now.",
        agent_notes: [
          "Apologize briefly; do not retry again this turn.",
          "Offer a callback, or suggest downloading the statement from the app or website instead.",
        ],
      };
    }
    const result = res.result;

    if (result && result.error) {
      return {
        error: result.error,
        message: result.message,
        agent_notes: result.agent_notes ?? [
          "The statement request failed. Apologize and offer to escalate to a human specialist.",
        ],
      };
    }

    const agent_notes: string[] = [...(result.agent_notes ?? [])];
    agent_notes.push(
      `Confirm the statement is on its way to the email on file (${result.email_masked}) and mention the ETA (${result.eta}). Do not read a full email address aloud.`
    );

    await recordFact(ctx, {
      tool: "account-request-statement",
      intent: "account/statement_request",
      action: "statement_requested",
    });

    return { ...result, agent_notes };
  },
});
