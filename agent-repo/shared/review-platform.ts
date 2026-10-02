import type { Context } from "@wonderful/types";

/**
 * Client for the external "Meridian Card Review Desk" public API
 * (contracts §2 review platform rows + §3). Config comes from the
 * REVIEW_PLATFORM secret: {"token": "<shared>", "public_base": "https://..."}
 * where public_base already ends at .../api/public/functions/<tenant>/<workspace>.
 *
 * Return contract (both calls): the parsed response body on success — flat
 * fields like case_id/status/decision plus the API's own agent_notes.
 * Application errors come back as the API sent them ({ error, ... }, e.g.
 * case_already_pending keeps its case_id). Network/HTTP failures are retried
 * once and then normalized to { error, message, agent_notes } — callers only
 * ever need to check `.error`.
 */

export type ReviewConfig = { token: string; public_base: string };

export function getConfig(
  ctx: Context
): { ok: true; config: ReviewConfig } | { ok: false; error: string } {
  let raw: unknown = null;
  try {
    raw = ctx.secrets.get("REVIEW_PLATFORM");
  } catch {
    return { ok: false, error: "review_platform_not_configured" };
  }
  if (!raw) {
    return { ok: false, error: "review_platform_not_configured" };
  }
  // "Other"-type secrets come back as the plain string; parse if needed.
  let parsed: any = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "review_platform_config_invalid" };
    }
  }
  if (!parsed?.token || !parsed?.public_base) {
    return { ok: false, error: "review_platform_config_invalid" };
  }
  // Trim a trailing slash so URL building is uniform.
  const base = String(parsed.public_base).replace(/\/+$/, "");
  return { ok: true, config: { token: String(parsed.token), public_base: base } };
}

function unreachable(message: string) {
  return {
    error: "review_platform_unreachable",
    message,
    agent_notes: [
      "The card review desk cannot be reached right now. Apologize; the request was not processed.",
      "Offer a callback once the review desk is reachable, or transfer via escalate-to-human.",
    ],
  };
}

function misconfigured(errorCode: string) {
  return {
    error: errorCode,
    message: "Review platform secret is missing or invalid.",
    agent_notes: [
      "The review desk connection is not configured. Apologize and offer escalate-to-human.",
    ],
  };
}

async function requestWithRetry(
  makeRequest: () => Promise<Response>
): Promise<any> {
  let lastMessage = "unknown_error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await makeRequest();
      const body = await response.json().catch(() => null);
      if (body && body.error) {
        // Application-level error (e.g. case_already_pending) — return as-is,
        // preserving extra fields like the existing case_id. No retry.
        return body;
      }
      if (!response.ok || body === null) {
        lastMessage = `review platform returned HTTP ${response.status}`;
        continue;
      }
      return body;
    } catch (err: any) {
      lastMessage = err?.message ? String(err.message) : String(err);
    }
  }
  console.error(`review platform request failed after retry: ${lastMessage}`);
  return unreachable(lastMessage);
}

/** POST a new unblock review case. Payload fields per contracts §2. */
export async function createCase(
  ctx: Context,
  payload: {
    customer_id: string;
    card_id: string;
    card_last4: string;
    block_reason: string;
    customer_stated_reason: string;
    channel: string;
    timestamp: string;
  }
): Promise<any> {
  const cfg = getConfig(ctx);
  if (!cfg.ok) {
    return misconfigured(cfg.error);
  }
  const url = `${cfg.config.public_base}/mcc-review-cases-create`;
  return requestWithRetry(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: cfg.config.token, ...payload }),
    })
  );
}

/** GET case status by case_id or customer_id (token as query param). */
export async function getStatus(
  ctx: Context,
  query: { case_id?: string; customer_id?: string }
): Promise<any> {
  const cfg = getConfig(ctx);
  if (!cfg.ok) {
    return misconfigured(cfg.error);
  }
  const params: string[] = [`token=${encodeURIComponent(cfg.config.token)}`];
  if (query.case_id) {
    params.push(`case_id=${encodeURIComponent(query.case_id)}`);
  }
  if (query.customer_id) {
    params.push(`customer_id=${encodeURIComponent(query.customer_id)}`);
  }
  const url = `${cfg.config.public_base}/mcc-review-cases-status?${params.join("&")}`;
  return requestWithRetry(() => fetch(url, { method: "GET" }));
}
