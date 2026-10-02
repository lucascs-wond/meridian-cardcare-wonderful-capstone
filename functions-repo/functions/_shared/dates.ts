// Date helpers for the sandboxed function runtime.
// The runtime injects a global `Moment` — NEVER use `new Date()` in
// tool/function code. The Date fallbacks below exist ONLY so these helpers
// keep working in local vitest runs where the Moment global is not injected;
// on the platform the Moment branch always wins.

declare const Moment: any;

/** Current instant as an RFC3339/ISO string. */
export function nowIso(): string {
  if (typeof Moment !== "undefined") {
    return Moment.now().toIsoString();
  }
  // Local-test fallback only — the platform runtime always provides Moment.
  return new Date().toISOString();
}

/** Current instant as epoch milliseconds (derived from nowIso — no `new Date()` on the platform path). */
export function nowEpochMs(): number {
  return Date.parse(nowIso());
}

/** Today's calendar date, YYYY-MM-DD. */
export function todayIsoDate(): string {
  return nowIso().slice(0, 10);
}

/**
 * Whole days elapsed since an ISO date/datetime string (negative when the
 * date is in the future). Number() wrap guards against BigInt-producing
 * diffs per the runtime notes.
 */
export function daysSince(iso: string): number {
  return Math.floor(Number(nowEpochMs() - Date.parse(iso)) / 86_400_000);
}

/** Calendar date (YYYY-MM-DD) exactly `days` from now; negative goes back. */
export function addDaysIsoDate(days: number): string {
  if (typeof Moment !== "undefined") {
    return Moment.now().addDays(days).toIsoString().slice(0, 10);
  }
  // Local-test fallback only — the platform runtime always provides Moment.
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
