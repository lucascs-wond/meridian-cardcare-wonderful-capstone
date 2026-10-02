import { s, w } from "@wonderful/types/schema";
import type { SessionFacts } from "../../shared/auth-state";

/**
 * on_end finalizer (contracts §5, architecture §13). Flushes the session_facts
 * KV accumulator into: (1) a structured post-interaction summary (logged and
 * stored as communication metadata), (2) the 3-layer tag taxonomy
 * (intent-*, outcome-*, channel-* — slugs match agent/tags/*.json), and
 * (3) flat scalar metadata keys for Interactions filtering.
 * Non-agent trigger — returns nothing user-visible.
 */

const params = s.object({});

/** "Unblock request" → "unblock-request" (tag slugs are kebab-case). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default w.tool({
  name: "session-finalize",
  description:
    "Internal end-of-session hook. Writes the post-interaction summary, tags, and " +
    "metrics metadata. Never call this during a conversation.",
  params,
  trigger: "on_end",
  handler: async (ctx) => {
    let facts: SessionFacts = { intents: [], tools_used: [], actions: [] };
    try {
      if (await ctx.kv.exists("session_facts")) {
        facts = (await ctx.kv.get("session_facts")) as SessionFacts;
      }
    } catch (err: any) {
      console.error(`session-finalize: facts read failed: ${err?.message ?? err}`);
    }

    const comm = ctx.metadata?.communication;
    const channel = comm?.type ? String(comm.type) : "voice";

    // Outcome resolution: explicit outcome wins; otherwise derive it.
    const outcome =
      facts.outcome ??
      (facts.escalated
        ? "escalated"
        : facts.actions.length > 0
          ? "resolved_self_service"
          : "no_action");

    // Duration from the transcript when a live session provides one.
    let durationMinutes: number | null = null;
    try {
      const transcript = ctx.session.getTranscription();
      if (transcript && transcript.length >= 2) {
        const first = transcript[0].createdAt;
        const last = transcript[transcript.length - 1].createdAt;
        // Moment diff can be a BigInt on the platform — normalize to Number.
        durationMinutes = Number(last.diffMinutes(first));
      }
    } catch {
      // Not available outside a live session — leave null.
    }

    // Follow-up needed when we escalated or a review case is still open.
    let followUp = facts.escalated === true;
    try {
      if (!followUp && (await ctx.kv.exists("unblock_case"))) {
        followUp = true;
      }
    } catch {
      // KV unavailable — keep the escalation-derived value.
    }

    // 3-layer tags. attachTag throws when a tag is not configured yet, so
    // each attach gets its own try/catch and failures are only logged.
    const tagNames = [
      ...facts.intents.map((intent) => `intent-${slugify(intent)}`),
      `outcome-${slugify(outcome)}`,
      `channel-${slugify(channel)}`,
    ];
    const appliedTags: string[] = [];
    for (const tagName of tagNames) {
      try {
        await ctx.metadata.attachTag(tagName);
        appliedTags.push(tagName);
      } catch (err: any) {
        console.error(`session-finalize: tag ${tagName} not attached: ${err?.message ?? err}`);
      }
    }

    const summary = {
      interaction_type: "customer_service",
      channel,
      duration_minutes: durationMinutes,
      verified: facts.verified === true,
      intents: facts.intents,
      actions_taken: facts.actions,
      tools_invoked: facts.tools_used,
      sms_sent: facts.sms_sent ?? [],
      outcome,
      follow_up_required: followUp,
      applied_tags: appliedTags,
    };
    console.log(`session-finalize summary: ${JSON.stringify(summary)}`);

    // Flat scalar keys only — objects/arrays are not filterable in dashboards.
    try {
      const meta = ctx.metadata.communication.metadata;
      meta.verified = facts.verified === true;
      meta.outcome = outcome;
      meta.intents = facts.intents.join(",");
      meta.tools_used = facts.tools_used.join(",");
      meta.follow_up = followUp;
      await ctx.metadata.saveCommunicationMetadata();
    } catch (err: any) {
      console.error(`session-finalize: metadata write failed: ${err?.message ?? err}`);
    }

    // Non-agent trigger: no speakable output, no agent_notes.
    return {};
  },
});
