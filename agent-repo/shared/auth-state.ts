import type { Context } from "@wonderful/types";

/**
 * Session auth state (contracts §4, KV key "auth").
 * Written ONLY by the verify-identity tool; read by every gated tool.
 * `phone` and `sms_opt_in` are cached from mcc-customers-lookup at
 * verification time so SMS tools never need to re-fetch (and never expose)
 * customer PII. PIN and DOB are NEVER stored here.
 */
export type AuthStatus =
  | "unverified"
  | "pin_pending"
  | "dob_pending"
  | "verified"
  | "locked";

export type AuthState = {
  status: AuthStatus;
  customer_id?: string;
  account_ids?: string[];
  primary_account_id?: string;
  first_name?: string;
  attempts: number;
  method?: "pin" | "dob+pin";
  verified_at?: string;
  phone?: string;
  sms_opt_in?: boolean;
};

export type SessionFacts = {
  intents: string[];
  tools_used: string[];
  actions: string[];
  outcome?: string;
  escalated?: boolean;
  verified?: boolean;
  sms_sent?: string[];
};

const AUTH_KEY = "auth";
const FACTS_KEY = "session_facts";

export async function getAuth(ctx: Context): Promise<AuthState> {
  // kv.get throws on a missing key — always check exists first.
  if (await ctx.kv.exists(AUTH_KEY)) {
    return (await ctx.kv.get(AUTH_KEY)) as AuthState;
  }
  return { status: "unverified", attempts: 0 };
}

export async function setAuth(
  ctx: Context,
  patch: Partial<AuthState>
): Promise<AuthState> {
  const next: AuthState = { ...(await getAuth(ctx)), ...patch };
  await ctx.kv.set(AUTH_KEY, next);
  return next;
}

export type RequireVerifiedResult =
  | { ok: true; auth: AuthState }
  | {
      ok: false;
      result: { error: string; message: string; agent_notes: string[] };
    };

/**
 * Auth gate — every account/fraud/rewards data tool calls this first.
 * Returns the standard refusal payload when the customer is not verified.
 */
export async function requireVerified(
  ctx: Context
): Promise<RequireVerifiedResult> {
  const auth = await getAuth(ctx);
  if (auth.status === "verified") {
    return { ok: true, auth };
  }
  return {
    ok: false,
    result: {
      error: "verification_required",
      message: "The customer has not completed identity verification.",
      agent_notes: [
        "Customer is not verified. Run verify-identity before any account action.",
      ],
    },
  };
}

/**
 * Append to the session_facts accumulator (flushed by session-finalize).
 * Every tool records itself here; string lists are kept unique.
 */
export async function recordFact(
  ctx: Context,
  fact: {
    intent?: string;
    tool: string;
    action?: string;
    outcome?: string;
    sms?: string;
    escalated?: boolean;
    verified?: boolean;
  }
): Promise<SessionFacts> {
  let facts: SessionFacts;
  if (await ctx.kv.exists(FACTS_KEY)) {
    facts = (await ctx.kv.get(FACTS_KEY)) as SessionFacts;
  } else {
    facts = { intents: [], tools_used: [], actions: [] };
  }

  const pushUnique = (list: string[], value?: string) => {
    if (value && !list.includes(value)) {
      list.push(value);
    }
  };

  pushUnique(facts.intents, fact.intent);
  pushUnique(facts.tools_used, fact.tool);
  pushUnique(facts.actions, fact.action);
  if (fact.sms) {
    facts.sms_sent = facts.sms_sent ?? [];
    pushUnique(facts.sms_sent, fact.sms);
  }
  if (fact.outcome !== undefined) {
    facts.outcome = fact.outcome;
  }
  if (fact.escalated !== undefined) {
    facts.escalated = fact.escalated;
  }
  if (fact.verified !== undefined) {
    facts.verified = fact.verified;
  }

  await ctx.kv.set(FACTS_KEY, facts);
  return facts;
}
