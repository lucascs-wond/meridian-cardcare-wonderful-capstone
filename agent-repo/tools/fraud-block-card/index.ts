import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { FN_PREFIX } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { renderTemplate } from "../../shared/sms-templates";
import { nowIso } from "../../shared/dates";

const params = s.object({
  card_last4: s
    .optional(s.string())
    .describe("Last 4 digits of the card to block. Omit if the customer did not specify one — the tool resolves it or asks."),
  reason: s
    .enum("lost", "stolen", "suspected_fraud", "travel_hold")
    .describe("Why the card is being blocked"),
  order_replacement: s
    .optional(s.boolean())
    .describe("Set true when the customer wants a replacement card ordered"),
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
  name: "fraud-block-card",
  description:
    "Blocks one of the verified customer's cards (lost, stolen, suspected fraud, or travel hold), optionally ordering a replacement, and texts a confirmation. Requires prior identity verification.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;

    let customer;
    try {
      customer = await runFn(ctx, `${FN_PREFIX}customers-lookup`, { customer_id: auth.customer_id });
    } catch (e) {
      return {
        error: "service_unavailable",
        message: "I could not load the card list right now.",
        agent_notes: [
          "Data lookup failed twice. Apologize and offer to try again in a moment, or transfer via escalate-to-human if the customer is worried about fraud.",
        ],
      };
    }
    if (!customer || customer.error) {
      return {
        error: "customer_not_found",
        message: "The customer profile could not be loaded.",
        agent_notes: ["Profile lookup returned no customer. Re-verify identity or escalate via escalate-to-human."],
      };
    }

    const cards = Array.isArray(customer.cards) ? customer.cards : [];
    let card;
    if (input.card_last4) {
      card = cards.find((c: { last4: string }) => c.last4 === input.card_last4);
      if (!card) {
        return {
          error: "card_not_found",
          message: `There is no card ending ${input.card_last4} on this profile.`,
          agent_notes: [
            `Cards on file end in: ${cards.map((c: { last4: string }) => c.last4).join(", ") || "none"}.`,
            "Ask the customer to re-confirm the last four digits, then call fraud-block-card again.",
          ],
        };
      }
    } else {
      const active = cards.filter((c: { status: string }) => c.status === "active");
      if (active.length === 0) {
        return {
          blocked: false,
          message: "There is no active card to block.",
          agent_notes: [
            `Card statuses on file: ${cards.map((c: { last4: string; status: string }) => `ending ${c.last4} is ${c.status}`).join("; ") || "no cards"}.`,
            "Inform the customer and ask what they would like to do next.",
          ],
        };
      }
      if (active.length > 1) {
        // Ambiguity branch: multiple active cards and no last4 given — ask, do not guess.
        return {
          needs_clarification: true,
          active_cards: active.map((c: { last4: string }) => c.last4).join(", "),
          agent_notes: [
            `The customer has multiple active cards: ${active
              .map((c: { card_type: string; last4: string }) => `${c.card_type} card ending ${c.last4}`)
              .join(", ")}.`,
            "Ask which card to block, then call fraud-block-card again with card_last4.",
          ],
        };
      }
      card = active[0];
    }

    if (card.status !== "active") {
      // Edge: already blocked (or otherwise not blockable) → inform, no write.
      return {
        card_last4: card.last4,
        card_status: card.status,
        already_blocked: card.status === "blocked" || card.status === "reported_lost",
        agent_notes: [
          `Card ending ${card.last4} is already ${card.status} — no new block was placed.`,
          "Inform the customer. If they want it unblocked, use fraud-request-unblock; a human specialist must review it.",
        ],
      };
    }

    let blockResult;
    try {
      blockResult = await runFn(ctx, `${FN_PREFIX}card-block`, {
        card_id: card.card_id,
        reason: input.reason,
        order_replacement: input.order_replacement === true,
      });
    } catch (e) {
      return {
        error: "service_unavailable",
        message: "The card could not be blocked right now.",
        agent_notes: [
          "card-block failed twice. This is security-sensitive: apologize and transfer via escalate-to-human so a human can block the card immediately.",
        ],
      };
    }
    if (blockResult && blockResult.error) {
      return blockResult;
    }

    // Auto-SMS confirmation — respects sms_opt_in; failure must not undo the block.
    let smsSent = false;
    if (customer.sms_opt_in === true && customer.phone) {
      const replacementLine = blockResult.replacement_ordered
        ? `is on the way and should arrive ${blockResult.replacement_eta}`
        : "was not ordered";
      try {
        const message = renderTemplate("card_blocked", {
          last4: blockResult.last4,
          reason: input.reason,
          date: nowIso().slice(0, 10),
          replacement_line: replacementLine,
        });
        ctx.telephony.sendSms(customer.phone, message, { senderId: "Meridian" });
        smsSent = true;
      } catch (smsError) {
        console.error("card_blocked SMS failed", smsError);
      }
    }

    await recordFact(ctx, {
      tool: "fraud-block-card",
      intent: "fraud/card_block",
      action: `card_blocked:${blockResult.last4}`,
      sms: smsSent ? "card_blocked" : undefined,
    });

    return {
      card_last4: blockResult.last4,
      new_status: blockResult.new_status,
      reason: input.reason,
      replacement_ordered: blockResult.replacement_ordered === true,
      replacement_eta: blockResult.replacement_eta ?? null,
      sms_sent: smsSent,
      agent_notes: [
        `Card ending ${blockResult.last4} is now ${blockResult.new_status}. Confirm this to the customer.`,
        blockResult.replacement_ordered
          ? `A replacement card was ordered — expected ${blockResult.replacement_eta}.`
          : "No replacement was ordered. Ask whether the customer would like one.",
        smsSent
          ? "A confirmation SMS was sent — tell the customer to expect a text from Meridian."
          : customer.sms_opt_in === true
            ? "The confirmation SMS could not be sent; confirm all details verbally instead."
            : "The customer is opted out of SMS, so confirm all details verbally.",
      ],
    };
  },
});
