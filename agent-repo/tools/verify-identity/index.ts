import { s, w } from "@wonderful/types/schema";
import type { Context } from "@wonderful/types";
import { callFn } from "../../shared/tables";
import {
  getAuth,
  setAuth,
  recordFact,
  type AuthState,
} from "../../shared/auth-state";
import { nowIso } from "../../shared/dates";

/**
 * "Digital Bookmark" verification state machine (architecture §4.3, contracts §5).
 * States (KV "auth"): unverified → pin_pending → verified, with a dob_pending
 * fallback when the caller ID does not match the phone on file, and a locked
 * terminal state after 3 failed attempts.
 *
 * The PIN and DOB from mcc-customers-lookup are compared INSIDE this tool and
 * are never returned to the model or stored in KV.
 */

const MAX_ATTEMPTS = 3;

const params = s.object({
  phone: s
    .optional(s.string())
    .describe(
      "Phone number on the customer's account, only if the customer stated one. Omit to use the caller ID."
    ),
  pin: s
    .optional(s.string())
    .describe("The customer's 4-digit verification PIN, only when the tool asked for it.")
    .sensitive(),
  date_of_birth: s
    .optional(s.string())
    .describe(
      "Customer's date of birth as YYYY-MM-DD, only when the tool asked for it."
    )
    .sensitive(),
});

/** Last 10 digits — tolerant of +1, spaces, dashes, spoken formats. */
function normalizePhone(phone: string | null | undefined): string {
  if (!phone) {
    return "";
  }
  return phone.replace(/\D/g, "").slice(-10);
}

/** Normalize a spoken/stated DOB to YYYY-MM-DD for exact comparison. */
function normalizeDob(dob: string): string {
  return dob.trim().slice(0, 10);
}

function lockedResult() {
  return {
    verified: false,
    locked: true,
    agent_notes: [
      "Verification is locked after 3 failed attempts.",
      "Do not attempt verification again. Apologize and call escalate-to-human to transfer the customer to a specialist.",
    ],
  };
}

function serviceError() {
  return {
    error: "verification_service_unavailable",
    message: "The customer lookup service did not respond after a retry.",
    agent_notes: [
      "The verification system is temporarily unavailable.",
      "Apologize, and offer to transfer to a specialist with escalate-to-human or suggest calling back shortly.",
    ],
  };
}

async function registerFailedAttempt(ctx: Context, auth: AuthState) {
  const attempts = auth.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await setAuth(ctx, { attempts, status: "locked" });
    await recordFact(ctx, {
      tool: "verify-identity",
      action: "verification_locked",
      outcome: "escalated",
    });
    return lockedResult();
  }
  await setAuth(ctx, { attempts });
  return {
    verified: false,
    attempts_remaining: MAX_ATTEMPTS - attempts,
    agent_notes: [
      `That did not match our records. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`,
      "Ask the customer to try again, reading slowly.",
    ],
  };
}

/** Re-fetch the customer privately for PIN/DOB comparison on later turns. */
async function loadCustomer(ctx: Context, auth: AuthState) {
  return callFn(ctx, "customers-lookup", { customer_id: auth.customer_id });
}

/** PIN_CHECK node — shared by the pin_pending state and same-turn fallthrough. */
async function checkPin(ctx: Context, pin: string, customer: any) {
  const auth = await getAuth(ctx);
  if (String(pin).trim() !== String(customer.verification_pin)) {
    return registerFailedAttempt(ctx, auth);
  }
  const accountIds: string[] = (customer.accounts ?? []).map(
    (a: any) => a.account_id
  );
  await setAuth(ctx, {
    status: "verified",
    customer_id: customer.customer_id,
    first_name: customer.first_name,
    account_ids: accountIds,
    primary_account_id: accountIds[0],
    verified_at: nowIso(),
    phone: customer.phone,
    sms_opt_in: customer.sms_opt_in === true,
  });
  await recordFact(ctx, {
    tool: "verify-identity",
    action: "identity_verified",
    verified: true,
  });
  const notes = [
    `Identity verified. Greet the customer by first name: ${customer.first_name}.`,
    "Call clear-eot-delay now that digit collection is done, then continue with the customer's request.",
  ];
  if (accountIds.length > 1) {
    notes.push(
      `The customer has ${accountIds.length} accounts. Ask which one they are calling about before account actions.`
    );
  }
  return { verified: true, first_name: customer.first_name, agent_notes: notes };
}

/** DOB_FALLBACK node. */
async function checkDob(
  ctx: Context,
  dob: string,
  pin: string | undefined,
  customer: any
) {
  const auth = await getAuth(ctx);
  if (normalizeDob(dob) !== normalizeDob(String(customer.date_of_birth))) {
    return registerFailedAttempt(ctx, auth);
  }
  await setAuth(ctx, { status: "pin_pending", method: "dob+pin" });
  if (pin) {
    return checkPin(ctx, pin, customer);
  }
  return {
    verified: false,
    agent_notes: [
      "Date of birth matched. Now ask for the customer's 4-digit verification PIN.",
      "Call set-eot-delay before the customer reads the digits.",
    ],
  };
}

export default w.tool({
  name: "verify-identity",
  description:
    "Verifies the caller's identity before any account, card, dispute, or rewards action. " +
    "Call with no params first (uses caller ID), then again with the pin or date_of_birth " +
    "the tool asks for. Locks after 3 failed attempts. Returns verification status and next step.",
  params,
  handler: async (ctx, input) => {
    const auth = await getAuth(ctx);

    if (auth.status === "locked") {
      return lockedResult();
    }
    if (auth.status === "verified") {
      return {
        verified: true,
        first_name: auth.first_name,
        agent_notes: [
          "Customer is already verified for this session. Continue with their request.",
        ],
      };
    }

    // PIN_CHECK state: we already know who the customer is.
    if (auth.status === "pin_pending") {
      if (!input.pin) {
        return {
          verified: false,
          agent_notes: [
            "Still waiting for the 4-digit verification PIN. Ask the customer for it.",
            "Call set-eot-delay before the customer reads the digits.",
          ],
        };
      }
      const lookup = await loadCustomer(ctx, auth);
      if (!lookup.ok || lookup.result?.error) {
        return serviceError();
      }
      return checkPin(ctx, input.pin, lookup.result);
    }

    // DOB_FALLBACK state: caller ID did not match, extra factor required.
    if (auth.status === "dob_pending") {
      if (!input.date_of_birth) {
        return {
          verified: false,
          agent_notes: [
            "Still waiting for the customer's date of birth. Ask for it as month, day, and year.",
            "Call set-eot-delay before the customer answers.",
          ],
        };
      }
      const lookup = await loadCustomer(ctx, auth);
      if (!lookup.ok || lookup.result?.error) {
        return serviceError();
      }
      return checkDob(ctx, input.date_of_birth, input.pin, lookup.result);
    }

    // PHONE_MATCH node (status unverified).
    const callerPhone = ctx.metadata?.communication?.fromNumber ?? null;
    const phone = input.phone ?? callerPhone;
    if (!phone) {
      return {
        verified: false,
        agent_notes: [
          "No caller ID is available. Ask the customer for the phone number on their account, then call verify-identity again with it.",
        ],
      };
    }

    const lookup = await callFn(ctx, "customers-lookup", { phone });
    if (!lookup.ok) {
      return serviceError();
    }
    if (lookup.result?.error) {
      if (!input.phone) {
        // Caller ID miss is not a failed attempt — ask for the phone on file.
        return {
          verified: false,
          agent_notes: [
            "The caller ID did not match an account. Ask the customer for the phone number on their account, then call verify-identity again with it.",
          ],
        };
      }
      return registerFailedAttempt(ctx, auth);
    }

    const customer = lookup.result;
    // Extra DOB factor when the stated phone does not match the line they call from.
    const needsDob =
      !!input.phone &&
      normalizePhone(callerPhone) !== normalizePhone(customer.phone);

    await setAuth(ctx, {
      status: needsDob ? "dob_pending" : "pin_pending",
      customer_id: customer.customer_id,
      first_name: customer.first_name,
      method: needsDob ? "dob+pin" : "pin",
    });
    await recordFact(ctx, { tool: "verify-identity", intent: "verification" });

    if (needsDob) {
      if (input.date_of_birth) {
        return checkDob(ctx, input.date_of_birth, input.pin, customer);
      }
      return {
        verified: false,
        agent_notes: [
          "Account found, but the caller is not on the phone we have on file, so an extra check is needed.",
          "Ask for the customer's date of birth (month, day, year). Call set-eot-delay first.",
        ],
      };
    }

    if (input.pin) {
      return checkPin(ctx, input.pin, customer);
    }
    return {
      verified: false,
      agent_notes: [
        "Account found from the caller ID. Ask for the customer's 4-digit verification PIN.",
        "Call set-eot-delay before the customer reads the digits.",
      ],
    };
  },
});
