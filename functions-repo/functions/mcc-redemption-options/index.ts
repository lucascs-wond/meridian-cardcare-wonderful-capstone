import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { customerHoldsVoyager, optionRestriction } from "../_shared/rewards";

// Lists the redemption catalog with per-option eligibility for this
// customer: tier for transfers, Voyager product for travel, balance >= min.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  if (!customerId) {
    return {
      error: "missing_parameter",
      message: "customer_id is required.",
      agent_notes: ["Use the verified customer_id from the auth state."]
    };
  }

  const { rows: balanceRows } = await context.tables.filter(
    T("rewards_balances"),
    [{ column: "customer_id", operator: "eq", value: customerId }],
    1,
    0
  );
  if (balanceRows.length === 0) {
    return {
      error: "rewards_not_found",
      message: "This customer has no rewards account.",
      agent_notes: ["The customer's card product does not earn points; nothing can be redeemed."]
    };
  }

  const balance = balanceRows[0].data;
  const hasVoyager = await customerHoldsVoyager(context, customerId);

  const { rows: optionRows } = await context.tables.query(T("redemption_options"), 100, 0, [
    { column: "option_id", direction: "asc" }
  ]);

  const options = optionRows.map((row) => {
    const option = row.data;
    const restriction = optionRestriction(option, balance.tier, hasVoyager);
    let eligible = true;
    let ineligibleReason: string | null = null;
    if (restriction) {
      eligible = false;
      ineligibleReason = restriction.reason;
    } else if (Number(balance.points_balance) < Number(option.min_points)) {
      eligible = false;
      ineligibleReason = `Requires at least ${option.min_points} points; current balance is ${balance.points_balance}.`;
    }
    return {
      option_id: option.option_id,
      name: option.name,
      min_points: option.min_points,
      // points_per_dollar = points needed per $1 of value.
      dollar_value_per_1000_points: Math.round((1000 / Number(option.points_per_dollar)) * 100) / 100,
      eligible,
      ineligible_reason: ineligibleReason
    };
  });

  const eligibleOptions = options.filter((o) => o.eligible);
  const best = [...(eligibleOptions.length > 0 ? eligibleOptions : options)].sort(
    (a, b) => b.dollar_value_per_1000_points - a.dollar_value_per_1000_points
  )[0];
  const bestValueNote = best
    ? eligibleOptions.length > 0
      ? `Best value available now: ${best.name} at $${best.dollar_value_per_1000_points} per 1,000 points.`
      : `No option is currently redeemable; the best-value option overall is ${best.name} at $${best.dollar_value_per_1000_points} per 1,000 points.`
    : "No redemption options are configured.";

  const eligibleIds = new Set(eligibleOptions.map((o) => o.option_id));
  const agentNotes: string[] = [
    `Customer has ${balance.points_balance} points. Present only the eligible options conversationally; mention why an option is unavailable only if asked.`
  ];
  if (optionRows.some((r) => r.data.category === "transfer" && eligibleIds.has(r.data.option_id))) {
    agentNotes.push("Partner transfers are irreversible — a two-step confirm is mandatory before executing one.");
  }

  return {
    options,
    best_value_note: bestValueNote,
    agent_notes: agentNotes
  };
}

