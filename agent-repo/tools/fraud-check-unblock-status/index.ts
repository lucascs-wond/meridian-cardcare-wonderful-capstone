import { s, w } from "@wonderful/types/schema";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { getStatus } from "../../shared/review-platform";

const params = s.object({
  case_id: s
    .optional(s.string())
    .describe("Review case ID to check. Omit to use the case filed earlier in this call, or the customer's most recent case."),
});

export default w.tool({
  name: "fraud-check-unblock-status",
  description:
    "Checks the human-review decision on a card unblock case at the external review desk. Requires prior identity verification.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    // Resolve which case to query: explicit param → session KV pointer → customer's latest case.
    let query: { case_id?: string; customer_id?: string };
    if (input.case_id) {
      query = { case_id: input.case_id };
    } else if (await ctx.kv.exists("unblock_case")) {
      // kv is async — exists/get must be awaited.
      query = { case_id: (await ctx.kv.get("unblock_case")).case_id };
    } else {
      query = { customer_id: auth.customer_id };
    }

    // Real HTTPS GET to the review platform's public API (retry once on network failure).
    let statusRes;
    try {
      statusRes = await getStatus(ctx, query);
    } catch (firstError) {
      try {
        statusRes = await getStatus(ctx, query);
      } catch (secondError) {
        return {
          error: "review_platform_unavailable",
          message: "The card review desk cannot be reached right now.",
          agent_notes: [
            "The review platform API failed twice. Apologize and offer to check again in a few minutes, a callback, or escalate-to-human.",
            "Remind the customer the decision also arrives by SMS once made.",
          ],
        };
      }
    }
    if (statusRes && statusRes.error) {
      if (statusRes.error === "case_not_found" || statusRes.error === "not_found") {
        return {
          error: "case_not_found",
          message: "No review case was found.",
          agent_notes: [
            "No case matches. Confirm the case ID with the customer, or offer fraud-request-unblock if none was ever filed.",
          ],
        };
      }
      return statusRes;
    }

    const decided = statusRes.status === "approved" || statusRes.status === "denied";
    if (decided && (await ctx.kv.exists("unblock_case"))) {
      // Clear the session pointer so a later unblock request for another card isn't mistaken for a duplicate.
      await ctx.kv.delete("unblock_case");
    }

    await recordFact(ctx, {
      tool: "fraud-check-unblock-status",
      intent: "fraud/unblock_status",
      action: `unblock_status_checked:${statusRes.case_id}:${statusRes.status}`,
    });

    const notes: string[] = [];
    if (statusRes.status === "approved") {
      notes.push(
        `Case ${statusRes.case_id} was APPROVED — the card is active again and can be used right away. Share the good news.`
      );
      if (statusRes.reviewer_notes) {
        notes.push(`Reviewer notes to relay: ${statusRes.reviewer_notes}`);
      }
    } else if (statusRes.status === "denied") {
      notes.push(
        `Case ${statusRes.case_id} was DENIED — the card stays blocked. Deliver this empathetically.`
      );
      notes.push(
        statusRes.reviewer_notes
          ? `Explain the reviewer's reason: ${statusRes.reviewer_notes}`
          : "No reviewer notes were provided."
      );
      notes.push("If the customer disagrees or has new information, offer escalate-to-human.");
    } else {
      notes.push(
        `Case ${statusRes.case_id} is still pending. Remind the customer a specialist reviews within 4 business hours of submission and the decision arrives by text.`
      );
    }

    return {
      case_id: statusRes.case_id,
      status: statusRes.status,
      decision: statusRes.decision ?? null,
      reviewer_notes: statusRes.reviewer_notes ?? null,
      decided_at: statusRes.decided_at ?? null,
      agent_notes: notes,
    };
  },
});
