import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn, kvGet } from "../../shared/pipeline";

const params = s.object({
  info: s
    .string()
    .describe("The customer's answer to the review's required_info, in their own words, confirmed back to them first"),
});

export default w.tool({
  name: "submit-case-info",
  description:
    "Sends information the customer just provided back to the dispute review (Agent 3 → Agent 2 loop): the case resumes processing automatically. Use for request_info cases after confirming the answer back to the customer — and for new evidence a customer offers on a rejected case.",
  params,
  handler: async (ctx: Context, input) => {
    const verified = await kvGet(ctx, "outbound_verified");
    if (verified !== true) {
      return {
        error: "not_verified",
        agent_notes: ["Never submit case information before confirm-identity succeeds on this call."],
      };
    }
    const briefing: any = await kvGet(ctx, "outbound_case");
    if (!briefing || !briefing.case_id) {
      return { error: "no_briefing", agent_notes: ["Run call-briefing first."] };
    }
    const res = await callFn(ctx, "case-info-submit", {
      case_id: briefing.case_id,
      info: input.info,
      source: "agent3-call",
    });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        agent_notes: [
          "The submission failed. Apologize, tell the customer we noted the information and the review team will follow up, and record disposition bad_time so the campaign retries.",
        ],
      };
    }
    return res.result;
  },
});
