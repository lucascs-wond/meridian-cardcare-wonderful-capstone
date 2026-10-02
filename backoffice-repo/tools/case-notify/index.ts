import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/pipeline";

const params = s.object({
  case_id: s.string().describe("The decided dispute case id to queue customer outreach for"),
});

export default w.tool({
  name: "case-notify",
  description:
    "Queues the outbound customer call for a decided case by creating one idempotent Campaign consumer (external_id = case_id, safe payload only). Refuses blocked cases. Call after case-decide for every outcome except blocked.",
  params,
  handler: async (ctx, input) => {
    const res = await callFn(ctx, "case-notify", { case_id: input.case_id });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The notification service is not responding.",
        agent_notes: ["The decision stands. Mark the task completed but report the notification failure in the summary."],
      };
    }
    return res.result;
  },
});
