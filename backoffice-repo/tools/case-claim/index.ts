import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/pipeline";

const params = s.object({
  case_id: s
    .optional(s.string())
    .describe("Optional: claim this exact case when the task payload names one; omit to claim the oldest waiting case"),
});

export default w.tool({
  name: "case-claim",
  description:
    "Binds this task to exactly one dispute case: claims the oldest case waiting for a decision (received or info_received) and moves it to processing. A duplicate delivery claims nothing — then the task completes as a no-op. Always the FIRST call of a dispute task.",
  params,
  handler: async (ctx, input) => {
    const res = await callFn(ctx, "case-claim", { case_id: input.case_id });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The case service is not responding.",
        agent_notes: ["Mark the task failed with this error."],
      };
    }
    return res.result;
  },
});
