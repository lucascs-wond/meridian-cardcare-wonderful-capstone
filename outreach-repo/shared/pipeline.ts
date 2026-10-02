import type { Context } from "@wonderful/types";

/** Deployed data-plane function slugs carry the Meridian CardCare prefix. */
export const FN_PREFIX = "mcc-";

export type FnResult = { ok: true; result: any } | { ok: false; error: string };

/**
 * Wrapper around context.functions.run for the mcc- pipeline functions.
 * Pass the bare slug (e.g. "case-decide"); the prefix is added here.
 * Retries once on failure, then normalizes to { ok, result | error }.
 */
export async function callFn(ctx: Context, slug: string, params: Record<string, unknown>): Promise<FnResult> {
  const fullSlug = `${FN_PREFIX}${slug}`;
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

/** kv.get THROWS key-not-found on missing keys (verified live) — safe wrapper. */
export async function kvGet(ctx: Context, key: string): Promise<any> {
  try {
    return await ctx.kv.get(key);
  } catch {
    return null;
  }
}
