// Shared naming helpers for the Meridian CardCare workspace functions.
// The workspace functions repo supports relative imports between
// functions/<slug>/ folders (platform notes 08, functions-git FAQ), so
// every function imports these instead of hardcoding prefixed names.

/** Real Resources table names carry this prefix (contracts §0/§1). */
export const TABLE_PREFIX = "mcc_";

/** Function slugs carry this prefix when deployed (contracts §2). */
export const FN_PREFIX = "mcc-";

/** T("customers") -> "mcc_customers" */
export function T(name: string): string {
  return TABLE_PREFIX + name;
}
