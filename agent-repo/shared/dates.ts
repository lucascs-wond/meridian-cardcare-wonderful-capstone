/**
 * Date helpers for the sandboxed tool/function runtime.
 *
 * The platform runtime provides a global `Moment` (never use `new Date()` in
 * tool code). When `Moment` is absent — i.e. local vitest runs only — we fall
 * back to the host Date. The fallback never executes on the platform.
 */

function momentGlobal(): any | null {
  const m = (globalThis as any).Moment;
  return typeof m !== "undefined" && m !== null ? m : null;
}

/** Current time as an ISO 8601 string. */
export function nowIso(): string {
  const M = momentGlobal();
  if (M) {
    return M.now().toIsoString();
  }
  // Local-test fallback only — platform runs always take the Moment branch.
  return new Date().toISOString();
}

/** Current date as "YYYY-MM-DD". */
export function todayYmd(): string {
  const M = momentGlobal();
  if (M) {
    return M.now().format("%Y-%m-%d");
  }
  // Local-test fallback only.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whole days from ymdA to ymdB (positive when B is later).
 * Uses Date.UTC arithmetic — deterministic, no timezone/DST drift, and no
 * `new Date()` construction, so it is safe in both runtimes.
 */
export function daysBetween(ymdA: string, ymdB: string): number {
  const toUtcMs = (ymd: string): number => {
    const [y, m, d] = ymd.slice(0, 10).split("-").map((p) => parseInt(p, 10));
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtcMs(ymdB) - toUtcMs(ymdA)) / 86400000);
}

/** Whole minutes elapsed since the given ISO timestamp (Date.parse is static). */
export function minutesSince(iso: string): number {
  const thenMs = Date.parse(iso);
  const nowMs = Date.parse(nowIso());
  if (Number.isNaN(thenMs) || Number.isNaN(nowMs)) {
    return 0;
  }
  return Math.floor((nowMs - thenMs) / 60000);
}
