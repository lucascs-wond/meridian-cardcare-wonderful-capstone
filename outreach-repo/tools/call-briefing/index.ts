import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn } from "../../shared/pipeline";

const params = s.object({});

// The dialed number binds the call to its case — no campaign plumbing needed.
function dialedNumber(ctx: Context): string | null {
  const comm: any = (ctx.metadata as any)?.communication || {};
  // Outbound: the customer is the dialed side. Field spelling varies by
  // surface (camelCase in runtime metadata, snake_case in records) — accept both.
  return (
    comm.customerNumber || comm.customer_number ||
    comm.toNumber || comm.to_number ||
    comm.fromNumber || comm.from_number || null
  );
}

export default w.tool({
  name: "call-briefing",
  description:
    "Silently loads this call's briefing: the case for the number we dialed — the customer's first name, the outcome to deliver, what to collect, and the opening variant. ALWAYS the first call of the conversation, before any substantive line.",
  params,
  handler: async (ctx, _input) => {
    const phone = dialedNumber(ctx);
    if (!phone) {
      return {
        no_case: true,
        agent_notes: [
          "No dialed number is available — treat as a wrong-number situation: apologize for the disturbance, end politely, record disposition wrong_number.",
        ],
      };
    }

    const lookup = await callFn(ctx, "customers-lookup", { phone });
    if (!lookup.ok || !lookup.result || lookup.result.error || !lookup.result.customer_id) {
      return {
        no_case: true,
        agent_notes: [
          "The number does not match a Meridian customer. Apologize for the disturbance and end politely; record disposition wrong_number.",
        ],
      };
    }
    const customer = lookup.result; // lookup returns customer fields flat

    const status = await callFn(ctx, "dispute-status", { customer_id: customer.customer_id });
    const disputes: any[] = status.ok && status.result && Array.isArray(status.result.disputes) ? status.result.disputes : [];
    const candidates = disputes
      .filter((d) => d.case_state === "decided" || d.case_state === "info_requested")
      .filter((d) => ["queued", "delivered", "failed"].includes(d.notification_status || ""));
    const target = candidates.find((d) => d.notification_status === "queued") || candidates[0];
    if (!target) {
      return {
        no_case: true,
        first_name: customer.first_name,
        agent_notes: [
          "No dispute case is awaiting outreach for this customer. Apologize briefly for the call and end politely; record disposition completed with summary 'no active case'.",
        ],
      };
    }

    const detail = await callFn(ctx, "case-events-list", { case_id: target.dispute_id });
    const c = detail.ok && detail.result && detail.result.case ? detail.result.case : {};

    // Deterministic A/B split for the opening test: even case number → trust_first.
    const digits = String(target.dispute_id).replace(/\D/g, "");
    const openingVariant = digits && Number(digits.slice(-1)) % 2 === 0 ? "trust_first" : "basic";

    await ctx.kv.set("outbound_case", {
      case_id: target.dispute_id,
      customer_id: customer.customer_id,
      first_name: customer.first_name,
      outcome: c.outcome || target.outcome || null,
      opening_variant: openingVariant,
    });

    return {
      case_id: target.dispute_id,
      first_name: customer.first_name,
      dispute_type: c.dispute_type || null,
      outcome: c.outcome || target.outcome || null,
      amount: target.amount ?? null,
      rationale_plain: c.outcome_rationale || null,
      required_info: c.required_info || null,
      provisional_credit: c.provisional_credit === true,
      opening_variant: openingVariant,
      agent_notes: [
        `Briefing loaded for ${customer.first_name}, case ${target.dispute_id} (${c.outcome || target.outcome}). Use the ${openingVariant} opening.`,
        "Verify (name + date of birth via confirm-identity) before ANY case detail beyond the safe purpose.",
      ],
    };
  },
});
