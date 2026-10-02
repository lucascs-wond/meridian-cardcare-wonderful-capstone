import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn, kvGet } from "../../shared/pipeline";

const params = s.object({
  business_code: s
    .enum("completed", "request_info_collected", "callback_requested", "bad_time", "wrong_number", "do_not_call")
    .describe("Exactly one approved business code for this answered call"),
  summary: s
    .string()
    .describe("One line: what happened on the call. For callback_requested include the exact requested time."),
});

export default w.tool({
  name: "record-call-disposition",
  description:
    "Records THE disposition of this answered call: exactly one business code, written once (idempotent per call). Also attaches the code as a call tag so the Campaign's retry/stop/opt-out rules fire. Call it after the goodbye is agreed, before the call ends. Every answered call must end with exactly one disposition.",
  params,
  handler: async (ctx: Context, input) => {
    const briefing: any = await kvGet(ctx, "outbound_case");
    const already = await kvGet(ctx, "outbound_disposition");
    if (already) {
      return {
        already_recorded: true,
        business_code: already,
        agent_notes: ["A disposition was already recorded for this call — do not record another. Say goodbye and end."],
      };
    }

    const commId = (ctx.metadata as any)?.communication?.id || (ctx.metadata as any)?.contextId || null;
    const attemptId = `ATT-${commId || "unknown"}`;

    // The campaign's rules route on this call tag (tag_conditions).
    try {
      await ctx.metadata.attachTag(input.business_code);
    } catch (err: any) {
      console.error(`disposition tag not attached: ${err?.message ?? err}`);
    }

    const callbackAt =
      input.business_code === "callback_requested" ? await kvGet(ctx, "outbound_callback_at") : null;

    if (briefing && briefing.case_id) {
      const res = await callFn(ctx, "attempt-record", {
        attempt_id: attemptId,
        case_id: briefing.case_id,
        business_code: input.business_code,
        technical_outcome: "answered",
        summary: `[${briefing.opening_variant || "unknown"} opening] ${input.summary}`,
        retry_action: callbackAt ? "scheduled_callback" : null,
        next_attempt_at: callbackAt || null,
      });
      if (!res.ok) {
        return {
          error: "record_failed",
          agent_notes: ["The disposition write failed — end the call normally; the stuck-case monitor will surface it."],
        };
      }
      await ctx.kv.set("outbound_disposition", input.business_code);
      return { ...res.result, agent_notes: ["Disposition recorded. Finish the goodbye and end the call."] };
    }

    // No case bound (wrong number and similar) — the call tag alone routes the campaign.
    await ctx.kv.set("outbound_disposition", input.business_code);
    return {
      business_code: input.business_code,
      agent_notes: ["Disposition recorded (no case bound to this call). Finish the goodbye and end the call."],
    };
  },
});
