import { s, w } from "@wonderful/types/schema";

/**
 * Restores the default end-of-turn timing after digit collection.
 * No-op outside a live voice session (editor Run, unit tests).
 */

const params = s.object({});

export default w.tool({
  name: "clear-eot-delay",
  description:
    "Restores normal listening pace after digit collection. Call as soon as the " +
    "customer has finished reading a PIN, date of birth, or card number.",
  params,
  handler: async (ctx) => {
    try {
      // Only available in a live session; safe no-op elsewhere.
      (ctx.agent as any).clearEndOfTurnDelay();
    } catch (err: any) {
      console.error(`clear-eot-delay unavailable: ${err?.message ?? err}`);
    }
    return {
      agent_notes: ["Normal listening pace restored. Continue the conversation."],
    };
  },
});
