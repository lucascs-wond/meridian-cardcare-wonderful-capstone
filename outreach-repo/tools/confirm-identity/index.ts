import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn, kvGet } from "../../shared/pipeline";

const MAX_ATTEMPTS = 2;

const params = s.object({
  date_of_birth: s
    .string()
    .describe("The customer's stated date of birth as YYYY-MM-DD (call set-eot-delay before collecting it)"),
});

export default w.tool({
  name: "confirm-identity",
  description:
    "Outbound-call identity check: confirms the stated date of birth against the account for the case in this call's briefing. Required before any case detail beyond the safe purpose. Locks after 2 failed attempts — then suggest calling the number on the back of the card.",
  params,
  handler: async (ctx: Context, input) => {
    const briefing: any = await kvGet(ctx, "outbound_case");
    if (!briefing || !briefing.customer_id) {
      return {
        verified: false,
        error: "no_briefing",
        agent_notes: ["Run call-briefing first — there is no case bound to this call."],
      };
    }
    const attempts = Number((await kvGet(ctx, "outbound_verify_attempts")) || 0);
    if (attempts >= MAX_ATTEMPTS) {
      return {
        verified: false,
        locked: true,
        agent_notes: [
          "Verification is locked for this call. Suggest calling the number on the back of the card, record disposition wrong_number, and close politely.",
        ],
      };
    }

    const lookup = await callFn(ctx, "customers-lookup", { customer_id: briefing.customer_id });
    if (!lookup.ok || !lookup.result || !lookup.result.customer_id) {
      return {
        verified: false,
        error: "service_unavailable",
        agent_notes: ["The check is unavailable. Do not share case details; offer the callback path and close with disposition bad_time."],
      };
    }
    const onFile = String(lookup.result.date_of_birth || "").slice(0, 10);
    const stated = String(input.date_of_birth || "").trim().slice(0, 10);
    if (onFile && stated === onFile) {
      await ctx.kv.set("outbound_verified", true);
      return {
        verified: true,
        agent_notes: ["Verified. Call clear-eot-delay, then deliver the outcome per the briefing."],
      };
    }
    await ctx.kv.set("outbound_verify_attempts", attempts + 1);
    return {
      verified: false,
      attempts_left: MAX_ATTEMPTS - attempts - 1,
      agent_notes: [
        attempts + 1 >= MAX_ATTEMPTS
          ? "Second failure — verification is locked. Suggest the number on the back of the card, record disposition wrong_number, close politely."
          : "That date of birth does not match. Ask once more, carefully (month, day, year).",
      ],
    };
  },
});
