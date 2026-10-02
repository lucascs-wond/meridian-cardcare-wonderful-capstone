import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";
import { nowEpochMs, nowIso } from "../_shared/dates";
import { customerHoldsVoyager, optionRestriction } from "../_shared/rewards";

// Executes a confirmed redemption: re-validates min_points/tier/product
// eligibility BEFORE any write, then atomically decrements the points
// balance and records the redemption_history row.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  const optionId = context.data.option_id;
  const points = Number(context.data.points);

  if (!customerId || !optionId || !context.data.points) {
    return {
      error: "missing_parameter",
      message: "customer_id, option_id, and points are required.",
      agent_notes: ["Quote the redemption first (rewards-redeem-points quote phase) and confirm before executing."]
    };
  }
  if (!Number.isFinite(points) || points <= 0 || !Number.isInteger(points)) {
    return {
      error: "invalid_points",
      message: "points must be a positive whole number.",
      agent_notes: ["Re-quote with a whole number of points."]
    };
  }

  const { rows: optionRows } = await context.tables.filter(
    T("redemption_options"),
    [{ column: "option_id", operator: "eq", value: optionId }],
    1,
    0
  );
  if (optionRows.length === 0) {
    return {
      error: "option_not_found",
      message: "No redemption option matches that option_id.",
      agent_notes: ["Re-list options via mcc-redemption-options and re-quote."]
    };
  }
  const option = optionRows[0].data;

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
  const balanceRow = balanceRows[0];
  const balance = balanceRow.data;

  // All eligibility gates run BEFORE any table write.
  if (points < Number(option.min_points)) {
    return {
      error: "below_minimum",
      message: `${option.name} requires at least ${option.min_points} points per redemption.`,
      agent_notes: [
        `Offer to redeem at least ${option.min_points} points, or suggest an option with a lower minimum.`
      ]
    };
  }
  const restriction = optionRestriction(option, balance.tier, await customerHoldsVoyager(context, customerId));
  if (restriction) {
    return {
      error: restriction.code,
      message: restriction.reason,
      agent_notes: [
        "This option is not available to the customer. Suggest eligible alternatives from mcc-redemption-options."
      ]
    };
  }
  if (Number(balance.points_balance) < points) {
    return {
      error: "insufficient_points",
      message: `Balance is ${balance.points_balance} points; ${points} were requested (short by ${points - Number(balance.points_balance)}).`,
      agent_notes: [
        `The customer has ${balance.points_balance} points. Offer a smaller redemption or an option within reach.`
      ]
    };
  }

  const valueUsd = Math.round((points / Number(option.points_per_dollar)) * 100) / 100;

  // Race-free debit, then the durable history record.
  const updated = await context.tables.atomicDecrease(
    T("rewards_balances"),
    balanceRow.id,
    "points_balance",
    points
  );

  const redemptionId = `RDM-${nowEpochMs()}`;
  await context.tables.insert(T("redemption_history"), {
    redemption_id: redemptionId,
    customer_id: customerId,
    option_id: optionId,
    points_spent: points,
    value_usd: valueUsd,
    status: "completed",
    requested_at: nowIso()
  });

  const agentNotes: string[] = [
    `Redemption complete: ${points} points for $${valueUsd} of ${option.name}. New balance: ${updated.data.points_balance} points.`
  ];
  if (option.category === "transfer") {
    agentNotes.push("This partner transfer is irreversible — confirm it has been sent and cannot be undone.");
  }

  return {
    redemption_id: redemptionId,
    points_spent: points,
    value_usd: valueUsd,
    new_balance: updated.data.points_balance,
    agent_notes: agentNotes
  };
}

