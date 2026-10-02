// Shared redemption-eligibility rules used by mcc-redemption-options and
// mcc-redemption-execute so the quote and the execution can never disagree.

import type { Context } from "@wonderful/types";
import { T } from "./tables";

/** True when any of the customer's accounts is on a Voyager product. */
export async function customerHoldsVoyager(context: Context, customerId: string): Promise<boolean> {
  const { rows: accountRows } = await context.tables.filter(
    T("accounts"),
    [{ column: "customer_id", operator: "eq", value: customerId }],
    100,
    0
  );
  const productIds = [...new Set(accountRows.map((r) => r.data.product_id))];
  if (productIds.length === 0) {
    return false;
  }
  const { rows: productRows } = await context.tables.filter(
    T("card_products"),
    [{ column: "product_id", operator: "in", value: productIds }],
    100,
    0
  );
  return productRows.some((r) => String(r.data.name).includes("Voyager"));
}

/**
 * Category-level restriction check (contracts §2): partner transfers need
 * platinum tier; the travel portal needs a Voyager product. Returns null
 * when the option has no category restriction for this customer.
 */
export function optionRestriction(
  option: Record<string, any>,
  tier: string,
  hasVoyager: boolean
): { code: "tier_restricted" | "product_restricted"; reason: string } | null {
  if (option.category === "transfer" && tier !== "platinum") {
    return {
      code: "tier_restricted",
      reason: `Partner transfers require platinum tier; this customer is ${tier}.`
    };
  }
  if (option.category === "travel" && !hasVoyager) {
    return {
      code: "product_restricted",
      reason: "Travel portal redemptions require a Meridian Voyager card."
    };
  }
  return null;
}
