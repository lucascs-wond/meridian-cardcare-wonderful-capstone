import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/pipeline";

const params = s.object({
  case_id: s.string().describe("The dispute case id from the task payload (e.g. DSP-1788...)"),
});

export default w.tool({
  name: "case-evidence",
  description:
    "Loads the full evidence bundle for a dispute case: the case record, disputed transaction, sibling transactions, card status, ownership validation, and rulebook flags. Always the first call of a dispute task.",
  params,
  handler: async (ctx, input) => {
    const res = await callFn(ctx, "case-get", { case_id: input.case_id });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The case service is not responding.",
        agent_notes: ["Mark the task failed with this error — do not decide without evidence."],
      };
    }
    return res.result;
  },
});
