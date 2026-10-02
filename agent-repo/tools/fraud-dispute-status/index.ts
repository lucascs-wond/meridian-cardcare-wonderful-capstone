import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { FN_PREFIX } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { describeDisputeStatus, NEVER_GUESS_NOTE, type DisputeRow } from "../../shared/dispute-status";

const params = s.object({
  dispute_id: s
    .optional(s.string())
    .describe("Exact dispute case ID (DSP-…) if the customer has it. Omit to list the customer's disputes, newest first."),
  amount: s
    .optional(s.number())
    .describe("Charge amount in dollars the customer mentioned — used to highlight the matching case in the results"),
});

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
  name: "fraud-dispute-status",
  description:
    "Reads the REAL current status of the verified customer's transaction dispute case(s): review state, outcome, provisional credit. Call it whenever the customer asks about an existing dispute ('any update?', 'is it resolved?'), and after fraud-file-dispute reports the charge is already disputed. Never describe a dispute's progress without this tool's result.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    let statusRes;
    try {
      statusRes = await runFn(ctx, `${FN_PREFIX}dispute-status`, {
        customer_id: auth.customer_id,
        dispute_id: input.dispute_id,
      });
    } catch (e) {
      return {
        error: "service_unavailable",
        message: "Dispute status cannot be retrieved right now.",
        agent_notes: [
          "The status lookup failed twice, so the current state is UNKNOWN. Do NOT guess or invent a status.",
          "Tell the customer you can't pull the case up right now, and offer a follow-up call or escalate-to-human.",
        ],
      };
    }
    if (statusRes && statusRes.error) {
      return statusRes;
    }

    const disputes: DisputeRow[] = Array.isArray(statusRes.disputes) ? statusRes.disputes : [];
    if (disputes.length === 0) {
      return {
        disputes: [],
        agent_notes: ["No disputes on file for this customer. Offer to file one if they are reporting a bad charge."],
      };
    }

    // Highlight the case the customer is asking about when an amount was given.
    const match =
      input.amount != null
        ? disputes.find((d) => d.amount != null && Math.abs(Number(d.amount) - Number(input.amount)) < 0.005)
        : null;
    const focus = match ?? (disputes.length === 1 ? disputes[0] : null);

    await recordFact(ctx, {
      tool: "fraud-dispute-status",
      intent: "fraud/dispute_status",
      action: `dispute_status_checked:${focus ? focus.dispute_id : `all:${disputes.length}`}`,
    });

    const notes: string[] = [];
    if (focus) {
      notes.push(describeDisputeStatus(focus));
      if (disputes.length > 1) {
        notes.push(`The customer has ${disputes.length} dispute(s) on file in total — mention the others only if asked.`);
      }
    } else {
      notes.push(`${disputes.length} dispute(s) on file — statuses, newest first:`);
      for (const d of disputes.slice(0, 5)) {
        notes.push(describeDisputeStatus(d));
      }
    }
    notes.push(NEVER_GUESS_NOTE);

    return {
      disputes,
      matched_dispute: focus ?? null,
      agent_notes: notes,
    };
  },
});
