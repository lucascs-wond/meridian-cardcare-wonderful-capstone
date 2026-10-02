/**
 * SMS templates (contracts §8). Wording is contractual — only the {fill-ins}
 * vary. Every template fits a single SMS segment chain and is speak-safe.
 */

export function cardBlocked(fill: {
  last4: string;
  reason: string;
  date: string;
  replacement_line: string;
}): string {
  return (
    `Meridian: Your card ending ${fill.last4} was blocked (${fill.reason}) ` +
    `on ${fill.date}. A replacement ${fill.replacement_line}. ` +
    `Reply STOP to opt out. Not you? Call us now.`
  );
}

export function unblockCaseReceived(fill: {
  last4: string;
  case_id: string;
}): string {
  return (
    `Meridian: We received your unblock request for card ending ${fill.last4}. ` +
    `Case ${fill.case_id}. A specialist will review within 4 business hours. ` +
    `We'll text the decision.`
  );
}

export function unblockDecision(fill: {
  case_id: string;
  last4: string;
  decision: string;
  notes_line: string;
}): string {
  return (
    `Meridian: Update on case ${fill.case_id} — your card ending ${fill.last4} ` +
    `unblock request was ${fill.decision}. ${fill.notes_line}`
  );
}

export function paymentReminder(fill: {
  min_payment: string;
  last4: string;
  due_date: string;
}): string {
  return (
    `Meridian: Reminder — payment of ${fill.min_payment} for card ending ` +
    `${fill.last4} is due ${fill.due_date}. Pay in the app or call us.`
  );
}

export type TemplateName =
  | "card_blocked"
  | "unblock_case_received"
  | "unblock_decision"
  | "payment_reminder";

/** Name-based dispatcher for callers that pick the template dynamically. */
export function renderTemplate(
  name: TemplateName,
  fill: Record<string, string>
): string {
  switch (name) {
    case "card_blocked":
      return cardBlocked(fill as Parameters<typeof cardBlocked>[0]);
    case "unblock_case_received":
      return unblockCaseReceived(
        fill as Parameters<typeof unblockCaseReceived>[0]
      );
    case "unblock_decision":
      return unblockDecision(fill as Parameters<typeof unblockDecision>[0]);
    case "payment_reminder":
      return paymentReminder(fill as Parameters<typeof paymentReminder>[0]);
    default:
      throw new Error(`Unknown SMS template: ${name}`);
  }
}
