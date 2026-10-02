import { s, w } from "@wonderful/types/schema";
import { callFn } from "../../shared/pipeline";

const params = s.object({
  case_id: s.string().describe("The dispute case id being decided"),
  outcome: s
    .enum("auto_approve", "auto_reject", "request_info", "close_resolved", "blocked")
    .describe("The rulebook outcome for this case"),
  rationale: s
    .string()
    .describe("One or two specific, auditable sentences: the facts weighed and the rule they satisfied or failed"),
  rule_applied: s
    .optional(s.string())
    .describe("The rulebook rule this decision applied (e.g. 'duplicate_or_incorrect: matching sibling transaction')"),
  required_info: s
    .optional(s.string())
    .describe("request_info only: exactly what the customer must provide, phrased so Agent 3 can read it to them"),
});

export default w.tool({
  name: "case-decide",
  description:
    "Records THE decision for a dispute case. Enforces state transitions, ownership, evidence guards, and idempotency server-side — a replayed task or repeated call safely no-ops. Call exactly once per task, after case-evidence.",
  params,
  handler: async (ctx, input) => {
    const res = await callFn(ctx, "case-decide", {
      case_id: input.case_id,
      outcome: input.outcome,
      rationale: input.rationale,
      rule_applied: input.rule_applied,
      required_info: input.required_info,
    });
    if (!res.ok) {
      return {
        error: "service_unavailable",
        message: "The decision service is not responding.",
        agent_notes: ["Mark the task failed — the case keeps its current state and the stuck-case monitor surfaces it."],
      };
    }
    return res.result;
  },
});
