// Shared-token validation for the two PUBLIC review-platform functions
// (mcc-review-cases-create / mcc-review-cases-status). Public endpoints
// carry no API key, so every call must self-validate the caller-supplied
// token against the REVIEW_PLATFORM secret (contracts §2).

import type { Context } from "@wonderful/types";

type TokenCheck =
  | { ok: true }
  | { ok: false; result: { error: string; message: string; agent_notes: string[] } };

export function validateReviewToken(context: Context): TokenCheck {
  const raw = context.secrets.get("REVIEW_PLATFORM");

  // Secret shape is {"token": "...", "public_base": "..."}. Tolerate both a
  // structured secret (object) and an Other-type secret holding the JSON string.
  let expected: string | undefined;
  if (typeof raw === "string") {
    try {
      expected = JSON.parse(raw).token;
    } catch {
      expected = raw;
    }
  } else if (raw && typeof raw === "object") {
    expected = (raw as { token?: string }).token;
  }

  const provided = (context.data as Record<string, unknown>).token;
  if (!expected || typeof provided !== "string" || provided !== expected) {
    return {
      ok: false,
      result: {
        error: "unauthorized",
        message: "Invalid or missing review-platform token.",
        agent_notes: [
          "The review platform rejected the shared token. Do not retry blindly — the REVIEW_PLATFORM secret configuration needs to be verified."
        ]
      }
    };
  }
  return { ok: true };
}
