import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowIso } from "../_shared/dates";

const VALID_REASONS = ["lost", "stolen", "suspected_fraud", "travel_hold"];

// Blocks a card. Status by reason: lost/stolen -> reported_lost (replacement
// ordered by default); suspected_fraud -> blocked + fraud flag; travel_hold -> blocked.
async function userFunction(context: Context) {
  const cardId = context.data.card_id;
  const reason = context.data.reason;

  if (!cardId || !reason) {
    return {
      error: "missing_parameter",
      message: "card_id and reason are required.",
      agent_notes: ["Resolve the card via mcc-customers-lookup and confirm the block reason before retrying."]
    };
  }
  if (!VALID_REASONS.includes(reason)) {
    return {
      error: "invalid_reason",
      message: `reason must be one of: ${VALID_REASONS.join(", ")}.`,
      agent_notes: ["Map the customer's wording to lost, stolen, suspected_fraud, or travel_hold and retry."]
    };
  }

  const { rows } = await context.tables.filter(
    T("cards"),
    [{ column: "card_id", operator: "eq", value: cardId }],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "card_not_found",
      message: "No card matches that card_id.",
      agent_notes: ["Re-resolve the card from mcc-customers-lookup — the card_id did not match."]
    };
  }

  const card = rows[0].data;
  if (card.status === "closed") {
    return {
      error: "card_closed",
      message: "This card belongs to a closed account and cannot be blocked.",
      agent_notes: ["Explain the card is already closed; no block is needed."]
    };
  }
  if (card.status === "blocked" || card.status === "reported_lost") {
    return {
      error: "card_already_blocked",
      message: `Card ending ${card.last4} is already ${card.status} (reason: ${card.block_reason ?? "unknown"}).`,
      agent_notes: [
        "The card is already protected — inform the customer instead of blocking again.",
        "If they want it unblocked, route to the fraud-request-unblock flow."
      ]
    };
  }

  const isLossOrTheft = reason === "lost" || reason === "stolen";
  const newStatus = isLossOrTheft ? "reported_lost" : "blocked";
  // Lost/stolen orders a replacement unless explicitly declined; other reasons only on request.
  const replacementOrdered = isLossOrTheft
    ? context.data.order_replacement !== false
    : context.data.order_replacement === true;

  await context.tables.update(T("cards"), rows[0].id, {
    status: newStatus,
    block_reason: reason,
    blocked_at: nowIso(),
    is_fraud_flagged: reason === "suspected_fraud" ? true : card.is_fraud_flagged
  });

  const agentNotes: string[] = [
    `Card ending ${card.last4} is now ${newStatus}. Confirm this to the customer.`,
    "Send the card_blocked SMS confirmation via send-sms-confirmation."
  ];
  if (replacementOrdered) {
    agentNotes.push("A replacement card is on its way — mention the 3–5 business day ETA.");
  } else if (isLossOrTheft === false) {
    agentNotes.push("No replacement was ordered. Offer one if the customer needs a new card.");
  }
  if (reason === "suspected_fraud") {
    agentNotes.push(
      "Card is flagged for fraud. Offer to review recent suspicious charges and file disputes for anything unrecognized."
    );
  }

  return {
    card_id: card.card_id,
    last4: card.last4,
    new_status: newStatus,
    replacement_ordered: replacementOrdered,
    replacement_eta: replacementOrdered ? "3–5 business days" : null,
    agent_notes: agentNotes
  };
}

