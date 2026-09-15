import { getDb, hasDatabase } from "@/lib/db/client";
import {
  clientIp,
  FEED_READ,
  GENERATE_GUEST,
  GENERATE_GUEST_UNIDENTIFIED,
  GENERATE_USER,
  HEALTH,
  LOGIN_ACCOUNT,
  LOGIN_IP,
  PASSWORD_RESET_COMPLETE,
  PASSWORD_RESET_REQUEST_ACCOUNT,
  PASSWORD_RESET_REQUEST_IP,
  REGISTER,
  REPORT,
  RESUME_GUEST,
  RESUME_USER,
  STORIES_READ,
  STORIES_WRITE,
  UNIDENTIFIED_GUEST_IP,
  VERIFY_REQUEST,
  type RateLimitPolicy,
} from "./policy";
import { consumeToken, tooManyRequests } from "./store";

/**
 * Route-level rate limiting. Returns a 429 to send back, or null to proceed.
 */

async function apply(
  policy: RateLimitPolicy,
  identity: string,
  message: string,
  options: { failOpen?: boolean } = {}
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
    console.error(`[ratelimit] ${policy.scope} check failed:`, err);
    // Fail open only where that's explicitly requested (health) — see guardHealth.
    // Everywhere else, fail closed: the limiter's whole job is to bound what an
    // unauthenticated caller can spend on provider tokens, and failing open would
    // hand that budget to anyone who can make the database unhappy. The cost of
    // this choice is real and worth stating: a database outage stops generation
    // for guests, who would otherwise have been unaffected by one. Bounded spend
    // is the property worth keeping — see docs/adr/0015.
    if (options.failOpen) return null;
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
  const ip = clientIp(request);
  // No proxy header named an individual caller — see clientIp's doc comment.
  // Every guest in this state shares one bucket, so it gets the policy sized
  // for a shared population rather than the normal per-guest one.
  if (ip === UNIDENTIFIED_GUEST_IP) {
    return apply(
      GENERATE_GUEST_UNIDENTIFIED,
      ip,
      "Too many stories from unrecognized connections just now. Give it a few minutes, or sign in for a higher limit."
    );
  }
  return apply(
    GENERATE_GUEST,
    ip,
    "Too many stories from this connection just now. Give it a minute, or sign in for a higher limit."
  );
}

export function guardRegister(request: Request): Promise<Response | null> {
  return apply(REGISTER, clientIp(request), "Too many sign-up attempts. Try again shortly.");
}

/** Same signed-in-vs-guest identity split as guardGenerate (docs/adr/0043). */
export function guardResume(request: Request, userId: string | undefined): Promise<Response | null> {
  if (userId) {
    return apply(RESUME_USER, userId, "Too many reconnect attempts. Give it a moment and try again.");
  }
  return apply(RESUME_GUEST, clientIp(request), "Too many reconnect attempts. Give it a moment and try again.");
}

/**
 * Every route below already requires a session (401s otherwise), so identity
 * is always the account — there is no guest path to key by address for these.
 */
export function guardStoriesRead(userId: string): Promise<Response | null> {
  return apply(STORIES_READ, userId, "Too many requests. Give it a moment and try again.");
}

export function guardStoriesWrite(userId: string): Promise<Response | null> {
  return apply(STORIES_WRITE, userId, "Too many requests. Give it a moment and try again.");
}

export function guardFeedRead(userId: string): Promise<Response | null> {
  return apply(FEED_READ, userId, "Too many requests. Give it a moment and try again.");
}

export function guardReport(userId: string): Promise<Response | null> {
  return apply(REPORT, userId, "Too many reports from this account. Try again later.");
}

/**
 * Two independent buckets, checked in sequence — IP first, then account,
 * short-circuiting on whichever denies first (docs/adr/0046). Each check
 * spends its own bucket's token regardless of the other's outcome; the
 * "wasted" IP-bucket token on a request an account-bucket denial later
 * rejects is negligible next to the bcrypt compare a real attempt costs.
 */
export async function guardLogin(request: Request, email: string): Promise<Response | null> {
  const byIp = await apply(LOGIN_IP, clientIp(request), "Too many sign-in attempts. Try again shortly.");
  if (byIp) return byIp;
  return apply(
    LOGIN_ACCOUNT,
    email,
    "Too many sign-in attempts for this account. Try again shortly, or reset your password."
  );
}

/** Keyed by account, not address — requesting a resend only makes sense for
 *  an already-authenticated Writer (see POST /api/auth/verify/request). */
export function guardVerifyRequest(userId: string): Promise<Response | null> {
  return apply(VERIFY_REQUEST, userId, "Too many verification emails requested. Try again later.");
}

/** Same two-bucket shape as guardLogin, for the same reason — see policy.ts. */
export async function guardPasswordResetRequest(request: Request, email: string): Promise<Response | null> {
  const byIp = await apply(
    PASSWORD_RESET_REQUEST_IP,
    clientIp(request),
    "Too many password reset requests. Try again shortly."
  );
  if (byIp) return byIp;
  return apply(
    PASSWORD_RESET_REQUEST_ACCOUNT,
    email,
    "Too many password reset requests for this account. Try again shortly."
  );
}

export function guardPasswordResetComplete(request: Request): Promise<Response | null> {
  return apply(PASSWORD_RESET_COMPLETE, clientIp(request), "Too many attempts. Try again shortly.");
}

/**
 * failOpen: true, deliberately unlike every other caller of apply(). A health
 * endpoint that fails closed when its own rate-limit check can't reach the
 * database would return 429 during exactly the outage it exists to report —
 * masking a real "database: unreachable" behind a generic "too busy". There's
 * no meaningful budget to protect here the way there is for a paid generation
 * call, so availability wins over strict limiting on this one path.
 */
export function guardHealth(request: Request): Promise<Response | null> {
  return apply(HEALTH, clientIp(request), "Too many health checks from this address.", {
    failOpen: true,
  });
}
