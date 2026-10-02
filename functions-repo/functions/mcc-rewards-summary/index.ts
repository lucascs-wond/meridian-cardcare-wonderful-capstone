import type { Context } from "@wonderful/types";
import { T } from "../_shared/tables";

// Returns the customer's rewards balance, tier, and expiring-points outlook.
async function userFunction(context: Context) {
  const customerId = context.data.customer_id;
  if (!customerId) {
    return {
      error: "missing_parameter",
      message: "customer_id is required.",
      agent_notes: ["Use the verified customer_id from the auth state."]
    };
  }

  const { rows } = await context.tables.filter(
    T("rewards_balances"),
    [{ column: "customer_id", operator: "eq", value: customerId }],
    1,
    0
  );
  if (rows.length === 0) {
    return {
      error: "rewards_not_found",
      message: "This customer has no rewards account.",
      agent_notes: [
        "The customer's card product likely does not earn points. Offer general rewards-program info via card-knowledge instead."
      ]
    };
  }

  const balance = rows[0].data;

  const agentNotes: string[] = [
    `Customer has ${balance.points_balance} available points at ${balance.tier} tier. Points pending post after the statement closes.`
  ];
  if (Number(balance.points_expiring_next_90d) > 0) {
    agentNotes.push(
      `${balance.points_expiring_next_90d} points expire within 90 days — mention this proactively and offer redemption options.`
    );
  }

  return {
    points_balance: balance.points_balance,
    points_pending: balance.points_pending,
    tier: balance.tier,
    points_expiring_next_90d: balance.points_expiring_next_90d,
    lifetime_points: balance.lifetime_points,
    agent_notes: agentNotes
  };
}

