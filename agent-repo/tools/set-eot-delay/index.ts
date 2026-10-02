import { s, w } from "@wonderful/types/schema";

/**
 * Extends the end-of-turn delay to 3000 ms so callers are not cut off while
 * reading digits (PIN, DOB, card last-4). Pair with clear-eot-delay.
 * No-op outside a live voice session (editor Run, unit tests).
 */

const params = s.object({});

export default w.tool({
  name: "set-eot-delay",
  description:
    "Extends the listening pause to 3 seconds while the customer reads digits " +
    "(PIN, date of birth, card numbers). Call right before asking for digits; " +
    "call clear-eot-delay when digit collection is done.",
  params,
  handler: async (ctx) => {
    try {
      // Only available in a live session; safe no-op elsewhere.
      (ctx.agent as any).setEndOfTurnDelay(3000);
    } catch (err: any) {
      console.error(`set-eot-delay unavailable: ${err?.message ?? err}`);
    }
    return {
      agent_notes: [
        "Extended pause is active for digit collection. Ask for the digits now and wait patiently.",
        "Call clear-eot-delay as soon as the digits are collected.",
      ],
    };
  },
});
