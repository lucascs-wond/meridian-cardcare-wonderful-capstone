import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn } from "../../shared/tables";
import { requireVerified, recordFact } from "../../shared/auth-state";
import { nowIso, minutesSince } from "../../shared/dates";

const PENDING_KEY = "pending_redemption";
const QUOTE_TTL_MINUTES = 5;

const params = s.object({
  option_id: s
    .optional(s.string())
    .describe("Redemption option id (e.g. from rewards-list-redemption-options). Prefer this over option_name when known."),
  option_name: s
    .optional(s.string())
    .describe("Redemption option name as the customer said it, e.g. 'statement credit' or 'gift cards'. Used when option_id is unknown."),
  points: s
    .optional(s.number())
    .describe("Number of points the customer wants to redeem. Required to produce a quote."),
  confirm: s
    .optional(s.boolean())
    .describe(
      "Leave unset on the first (quote) call. Pass true ONLY on the second call, after the customer heard the quote read back and explicitly confirmed."
    ),
});

function outage() {
  return {
    error: "service_unavailable",
    message: "The rewards service is not responding right now.",
    agent_notes: [
      "Apologize briefly; no points were redeemed. Do not retry again this turn.",
      "Offer a callback or to continue with something else.",
    ],
  };
}

function passthroughError(result: any, fallbackNote: string) {
  return {
    error: result.error,
    message: result.message,
    agent_notes: result.agent_notes ?? [fallbackNote],
  };
}

function isIrreversibleTransfer(option: any): boolean {
  return option.category === "transfer" || /transfer/i.test(option.name ?? "");
}

// Friendly branches for every redemption-execute error code (contracts §2).
function mapExecuteError(result: any, pointsBalance?: number) {
  const notes: Record<string, string[]> = {
    insufficient_points: [
      pointsBalance !== undefined
        ? `The customer only has ${pointsBalance} points. Say so gently and offer a smaller redemption or an option with a lower minimum.`
        : "The customer does not have enough points. Say so gently and offer a smaller redemption or an option with a lower minimum.",
      "Do not retry with the same amount. Re-quote with a new amount if they want to proceed.",
    ],
    below_minimum: [
      "The requested amount is below this option's minimum. Tell the customer the minimum and ask if they want to redeem at least that much.",
      "Re-quote with a new amount if they want to proceed.",
    ],
    tier_restricted: [
      "This option requires a higher rewards tier. Explain the restriction using the message text and suggest an eligible option instead.",
    ],
    product_restricted: [
      "This option is limited to a specific card product. Explain the restriction using the message text and suggest an eligible option instead.",
    ],
  };
  return {
    error: result.error,
    message: result.message,
    agent_notes:
      notes[result.error] ??
      result.agent_notes ?? [
        "The redemption could not be completed and no points were spent. Apologize and offer alternatives or a human specialist.",
      ],
  };
}

async function quote(
  ctx: Context,
  customerId: string,
  sel: { option_id?: string; option_name?: string; points?: number },
  extraNotes: string[]
) {
  // callFn retries once internally and normalizes failures to { ok: false }.
  const optionsRes = await callFn(ctx, "redemption-options", { customer_id: customerId });
  if (!optionsRes.ok) {
    return outage();
  }
  const summaryRes = await callFn(ctx, "rewards-summary", { customer_id: customerId });
  if (!summaryRes.ok) {
    return outage();
  }
  const optionsResult = optionsRes.result;
  const summary = summaryRes.result;
  if (optionsResult && optionsResult.error) {
    return passthroughError(optionsResult, "Could not load redemption options. Apologize and offer to try again later.");
  }
  if (summary && summary.error) {
    return passthroughError(summary, "Could not load the rewards balance. Apologize and offer to try again later.");
  }

  const options: any[] = optionsResult.options ?? [];

  // Resolve the option by id first, then by (partial, case-insensitive) name.
  let option: any;
  if (sel.option_id) {
    option = options.find((o) => o.option_id === sel.option_id);
  } else if (sel.option_name) {
    const needle = sel.option_name.toLowerCase();
    const matches = options.filter((o) => {
      const name = (o.name ?? "").toLowerCase();
      return name.includes(needle) || needle.includes(name);
    });
    if (matches.length === 1) {
      option = matches[0];
    } else if (matches.length > 1) {
      return {
        error: "option_ambiguous",
        message: "More than one redemption option matches that name.",
        agent_notes: [
          `Ask the customer which one they mean: ${matches.map((o) => o.name).join(", ")}.`,
          "Then quote again with the exact option_id or full name.",
        ],
      };
    }
  }

  if (!option) {
    return {
      error: "option_not_found",
      message: "No redemption option matches that selection.",
      agent_notes: [
        `Available options: ${options.map((o) => o.name).join(", ")}.`,
        "Ask which one the customer wants, or run rewards-list-redemption-options to walk them through it.",
      ],
    };
  }

  if (option.eligible === false) {
    return {
      error: "option_not_eligible",
      message: option.ineligible_reason ?? `The customer is not eligible for ${option.name}.`,
      agent_notes: [
        `Explain why in one sentence: ${option.ineligible_reason ?? "this option is restricted"}.`,
        `Suggest an eligible option instead: ${
          options.filter((o) => o.eligible !== false).map((o) => o.name).join(", ") || "none right now"
        }.`,
      ],
    };
  }

  if (sel.points === undefined || sel.points === null) {
    return {
      needs_points: true,
      option_id: option.option_id,
      option_name: option.name,
      min_points: option.min_points,
      points_balance: summary.points_balance,
      agent_notes: [
        `Ask how many points to redeem for ${option.name}. Minimum is ${option.min_points}; the customer has ${summary.points_balance} points.`,
        "Then call rewards-redeem-points again with the chosen points (still no confirm flag).",
      ],
    };
  }

  if (sel.points < option.min_points) {
    return {
      error: "below_minimum",
      message: `${option.name} requires at least ${option.min_points} points.`,
      agent_notes: [
        `Tell the customer the minimum for ${option.name} is ${option.min_points} points and ask if they want to redeem at least that much.`,
      ],
    };
  }

  if (sel.points > summary.points_balance) {
    return {
      error: "insufficient_points",
      message: `The customer has ${summary.points_balance} points, fewer than the ${sel.points} requested.`,
      agent_notes: [
        `Say gently that only ${summary.points_balance} points are available.`,
        `Offer to redeem up to ${summary.points_balance} points instead, or suggest an option with a lower minimum.`,
      ],
    };
  }

  const valueUsd = Math.round((sel.points / 1000) * option.dollar_value_per_1000_points * 100) / 100;
  const pending = {
    option_id: option.option_id,
    option_name: option.name,
    points: sel.points,
    value_usd: valueUsd,
    quoted_at: nowIso(),
  };
  await ctx.kv.set(PENDING_KEY, pending);

  const agent_notes: string[] = [
    ...extraNotes,
    `Read the quote back: ${sel.points} points for $${valueUsd} as ${option.name}.`,
  ];
  if (isIrreversibleTransfer(option)) {
    agent_notes.push("This is a partner transfer and it is IRREVERSIBLE — warn the customer explicitly before asking them to confirm.");
  }
  agent_notes.push(
    "Ask the customer to confirm. Only after an explicit yes, call rewards-redeem-points again with confirm: true.",
    `If they decline or change anything, quote again; this quote expires in ${QUOTE_TTL_MINUTES} minutes.`
  );

  return {
    quoted: true,
    option_id: option.option_id,
    option_name: option.name,
    points: sel.points,
    value_usd: valueUsd,
    points_balance: summary.points_balance,
    agent_notes,
  };
}

export default w.tool({
  name: "rewards-redeem-points",
  description:
    "Redeems the verified customer's points in two phases: first call WITHOUT confirm produces a quote (points and dollar value) to read back; second call WITH confirm: true executes it. Never pass confirm: true unless the customer explicitly confirmed the exact quote. TWO-PHASE, STRICT: the first call must NOT include confirm — it only quotes. Only after the customer explicitly says yes to the spoken quote may you call again with confirm true. Never pass confirm true on the first call or in the same turn as the quote.",
  params,
  handler: async (ctx, input) => {
    const gate = await requireVerified(ctx);
    if (!gate.ok) {
      return gate.result;
    }
    const auth = gate.auth;
    const customerId = auth.customer_id;
    if (!customerId) {
      return {
        error: "no_customer_on_file",
        message: "Verified session has no customer id attached.",
        agent_notes: [
          "Something is wrong with the session state. Re-run verify-identity or escalate to a human specialist.",
        ],
      };
    }

    // ---- Confirm phase ----
    if (input.confirm === true) {
      const hasPending = await ctx.kv.exists(PENDING_KEY);
      if (!hasPending) {
        return {
          error: "no_pending_redemption",
          message: "There is no quoted redemption to confirm.",
          agent_notes: [
            "Nothing was redeemed. Quote first: call rewards-redeem-points with the option and points, without confirm.",
          ],
        };
      }

      const pending = await ctx.kv.get(PENDING_KEY);

      // Stale quote (older than 5 minutes) → clear it and re-quote the same selection.
      if (minutesSince(pending.quoted_at) >= QUOTE_TTL_MINUTES) {
        await ctx.kv.delete(PENDING_KEY);
        return await quote(
          ctx,
          customerId,
          { option_id: pending.option_id, points: pending.points },
          [
            "The previous quote expired (older than 5 minutes), so nothing was redeemed. A fresh quote follows — read it back and get a new confirmation.",
          ]
        );
      }

      // callFn retries once internally and normalizes failures to { ok: false }.
      const execRes = await callFn(ctx, "redemption-execute", {
        customer_id: customerId,
        option_id: pending.option_id,
        points: pending.points,
      });
      if (!execRes.ok) {
        // Keep the pending quote: the outage was transient and nothing was spent.
        return outage();
      }
      const result = execRes.result;

      if (result && result.error) {
        // Eligibility/balance changed since the quote; clear it so the flow restarts cleanly.
        await ctx.kv.delete(PENDING_KEY);
        return mapExecuteError(result);
      }

      await ctx.kv.delete(PENDING_KEY);
      await recordFact(ctx, {
        tool: "rewards-redeem-points",
        intent: "rewards/redeem",
        action: `redemption_executed:${pending.option_id}`,
      });

      const agent_notes: string[] = [...(result.agent_notes ?? [])];
      agent_notes.push(
        `Confirm it's done: ${result.points_spent} points redeemed for $${result.value_usd} (${pending.option_name}). New balance: ${result.new_balance} points.`
      );

      return { ...result, option_name: pending.option_name, agent_notes };
    }

    // ---- Quote phase ----
    return await quote(
      ctx,
      customerId,
      { option_id: input.option_id, option_name: input.option_name, points: input.points },
      []
    );
  },
});
