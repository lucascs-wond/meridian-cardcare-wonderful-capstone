import type { Context } from "@wonderful/types";

/**
 * Naming helpers — every deployed artifact carries the Meridian CardCare prefix
 * because the tenant workspace is shared (Slack guidance AGP-625).
 */
export const TABLE_PREFIX = "mcc_";
export const FN_PREFIX = "mcc-";

/** T("customers") → "mcc_customers" — real Resources table name. */
export function T(name: string): string {
  return `${TABLE_PREFIX}${name}`;
}

/** FN("customers-lookup") → "mcc-customers-lookup" — deployed function slug. */
export function FN(slug: string): string {
  return `${FN_PREFIX}${slug}`;
}

export type FnResult =
  | { ok: true; result: any }
  | { ok: false; error: string };

/**
 * Wrapper around context.functions.run for the mcc- data-plane functions.
 * Pass the bare slug (e.g. "customers-lookup"); the prefix is added here.
 * Retries once on failure, then normalizes to { ok, result | error } so tools
 * can branch without try/catch at every call site.
 */
export async function callFn(
  ctx: Context,
  slug: string,
  params: Record<string, unknown>
): Promise<FnResult> {
  const fullSlug = FN(slug);
  let lastError = "unknown_error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { result } = await ctx.functions.run({ slug: fullSlug, params });
      return { ok: true, result };
    } catch (err: any) {
      lastError = err?.message ? String(err.message) : String(err);
    }
  }
  console.error(`callFn(${fullSlug}) failed after retry: ${lastError}`);
  return { ok: false, error: lastError };
}
