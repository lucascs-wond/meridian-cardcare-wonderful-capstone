import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";

const MAX_HORIZON_DAYS = 14;

const params = s.object({
  requested_time: s
    .string()
    .describe(
      "The exact callback time the customer asked for, as ISO 8601 with a UTC offset, e.g. 2026-09-01T18:00:00-04:00. Confirm the time AND timezone with the customer first; if they name no timezone, assume the campaign's timezone (Eastern Time)."
    ),
});

export default w.tool({
  name: "schedule-callback",
  description:
    "Schedules the platform to call this customer back at the exact time they requested. Use ONLY when the customer gives a specific date and time. After it succeeds: confirm the time back to them, then record disposition callback_requested with the time in the summary.",
  params,
  handler: async (ctx: Context, input) => {
    const t = Date.parse(input.requested_time);
    if (!Number.isFinite(t)) {
      return {
        error: "invalid_time",
        agent_notes: [
          "That time could not be parsed. Re-confirm the exact date, time, and timezone with the customer, then try once more.",
        ],
      };
    }
    const now = Date.now();
    if (t < now + 5 * 60 * 1000) {
      return {
        error: "time_in_past",
        agent_notes: [
          "The requested time is in the past or under five minutes away. Ask for a time a little further out, or close with disposition bad_time.",
        ],
      };
    }
    if (t > now + MAX_HORIZON_DAYS * 24 * 3600 * 1000) {
      return {
        error: "too_far_out",
        agent_notes: [
          `Callbacks can be scheduled up to ${MAX_HORIZON_DAYS} days ahead. Offer the latest date in that window, or suggest they call the number on the back of their card when ready.`,
        ],
      };
    }

    const iso = new Date(t).toISOString();
    try {
      await (ctx as any).campaign.callback(iso);
    } catch (err: any) {
      console.error(`campaign callback scheduling failed: ${err?.message ?? err}`);
      return {
        error: "schedule_failed",
        agent_notes: [
          "Scheduling is unavailable right now. Apologize, say we'll try them again soon during calling hours, and record disposition bad_time instead.",
        ],
      };
    }

    await ctx.kv.set("outbound_callback_at", iso);
    return {
      scheduled_for: iso,
      agent_notes: [
        "Callback scheduled. Confirm the exact date and time back to the customer in their own local terms.",
        "Then record disposition callback_requested with the time in the summary, say goodbye, and end the call.",
      ],
    };
  },
});
