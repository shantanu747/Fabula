import { getDb, hasDatabase } from "@/lib/db/client";
import {
  clientIp,
  GENERATE_GUEST,
  GENERATE_USER,
  REGISTER,
  type RateLimitPolicy,
} from "./policy";
import { consumeToken, tooManyRequests } from "./store";

/**
 * Route-level rate limiting. Returns a 429 to send back, or null to proceed.
 */

async function apply(
  policy: RateLimitPolicy,
  identity: string,
  message: string
): Promise<Response | null> {
  // No database configured means no shared counter to keep. This is the local
  // "clone it and try the guest flow" case; every deployed environment has one.
  // Announced rather than silent, because a limiter that is quietly off is worse
  // than none at all.
  if (!hasDatabase()) {
    console.warn(`[ratelimit] no DATABASE_URL — ${policy.scope} is not being limited`);
    return null;
  }

  let result;
  try {
    result = await consumeToken(getDb(), policy, identity);
  } catch (err) {
    // Fail closed. The limiter's whole job is to bound what an unauthenticated
    // caller can spend on provider tokens, and failing open would hand that
    // budget to anyone who can make the database unhappy. The cost of this
    // choice is real and worth stating: a database outage stops generation for
    // guests, who would otherwise have been unaffected by one. Bounded spend is
    // the property worth keeping — see docs/adr/0015.
    console.error(`[ratelimit] ${policy.scope} check failed; denying:`, err);
    return tooManyRequests({ retryAfterSeconds: 5 }, "Too busy right now. Try again in a moment.");
  }

  if (result.allowed) return null;
  return tooManyRequests(result, message);
}

/**
 * A signed-in Writer is limited per account, everyone else per address. Keying
 * a signed-in Writer by IP instead would make a household on one connection
 * share a single budget.
 */
export function guardGenerate(request: Request, userId: string | undefined): Promise<Response | null> {
  if (userId) {
    return apply(
      GENERATE_USER,
      userId,
      "You're writing faster than we can keep up. Give it a few seconds and try again."
    );
  }
  return apply(
    GENERATE_GUEST,
    clientIp(request),
    "Too many stories from this connection just now. Give it a minute, or sign in for a higher limit."
  );
}

export function guardRegister(request: Request): Promise<Response | null> {
  return apply(REGISTER, clientIp(request), "Too many sign-up attempts. Try again shortly.");
}
