// Shared phrasing for dispute-case status so every tool grounds the agent the
// same way. The one rule this file exists to enforce: the agent must never
// describe a case's progress from imagination — only from these notes.

export type DisputeRow = {
  dispute_id?: string;
  status?: string;
  amount?: number;
  filed_at?: string;
  expected_resolution_date?: string;
  resolution?: string;
  case_state?: string | null;
  outcome?: string | null;
  required_info?: string | null;
  provisional_credit?: boolean;
  notification_status?: string | null;
};

// One customer-facing sentence per case, derived from pipeline state — never guessed.
export function describeDisputeStatus(d: DisputeRow): string {
  const id = d.dispute_id ?? "unknown";
  const amount = d.amount != null ? ` ($${d.amount})` : "";
  const state = d.case_state ?? null;
  const outcome = d.outcome ?? null;

  if (state === "info_requested") {
    return `Case ${id}${amount} is WAITING ON THE CUSTOMER: ${d.required_info ?? "additional information"}. If they can provide it now, collect it; otherwise our outbound call will.`;
  }
  if (state === "received" || state === "processing") {
    return `Case ${id}${amount} is genuinely under review — decision usually within 1 business day, delivered by text heads-up then a call.`;
  }
  if (outcome === "auto_approve") {
    const credit = d.provisional_credit
      ? "a provisional credit has been issued and posts within 2 business days"
      : "the credit is being finalized";
    return `Case ${id}${amount} was APPROVED — share the good news: ${credit}. No further review is happening.`;
  }
  if (outcome === "auto_reject") {
    return `Case ${id}${amount} was NOT approved. Deliver this empathetically, explain they can provide new evidence or contact support, and offer escalate-to-human if they push back.`;
  }
  if (outcome === "close_resolved") {
    return `Case ${id}${amount} is resolved — the merchant already credited it; no further action is needed.`;
  }
  if (state === "blocked") {
    return `Case ${id}${amount} needs a specialist and cannot be discussed in detail — offer escalate-to-human.`;
  }
  if (state === "closed" || d.status === "closed") {
    return `Case ${id}${amount} is closed${outcome ? ` (outcome: ${outcome})` : ""} — the decision was already communicated.`;
  }
  return `Case ${id}${amount} status: ${d.status ?? "unknown"}${state ? ` (${state})` : ""}. Relay only this — do not embellish.`;
}

export const NEVER_GUESS_NOTE =
  "Never tell the customer a case is 'being reviewed by a specialist' or promise an update unless THIS result says so — state only what is written here.";
