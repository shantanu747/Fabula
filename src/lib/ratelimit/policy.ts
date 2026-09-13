import { createHash } from "node:crypto";

/**
 * Rate-limit policies and the identity a request is limited under.
 *
 * Kept free of database access so the arithmetic and the key derivation can be
 * tested without one. The single statement that applies a policy lives in
 * ./store.ts.
 */

export interface RateLimitPolicy {
  /** Burst size: how many requests are allowed back to back from cold. */
  capacity: number;
  /** Sustained rate, as tokens per second. */
  refillPerSecond: number;
  /** Prefix so one caller's buckets for different endpoints stay separate. */
  scope: string;
}

/**
 * A guest costs real money on every call and is identified only by IP, so the
 * burst is small. Sustained: two generations a minute, which is faster than
 * anyone writes a paragraph and slow enough that a script is not worth running.
 */
export const GENERATE_GUEST: RateLimitPolicy = {
  scope: "generate:guest",
  capacity: 5,
  refillPerSecond: 1 / 30,
};

/**
 * Applied instead of GENERATE_GUEST when `clientIp` cannot name an individual
 * caller (`UNIDENTIFIED_GUEST_IP`). Every guest in that state shares this one
 * bucket, so its numbers describe the whole population's budget, not one
 * person's — capacity is left at 5 (a lone local-dev "clone it and try the
 * guest flow" run still works without friction) but the sustained rate is cut
 * 10x versus GENERATE_GUEST, so that if this bucket ever *is* absorbing more
 * than one real caller (no proxy in front of a self-hosted deployment, or this
 * app's own E2E suite), it becomes unusable quickly rather than quietly
 * handing out a normal per-caller budget to an unbounded number of callers.
 */
export const GENERATE_GUEST_UNIDENTIFIED: RateLimitPolicy = {
  scope: "generate:guest:unidentified",
  capacity: 5,
  refillPerSecond: 1 / 300,
};

/**
 * A signed-in Writer has a real account behind them and a story in progress, so
 * they get a larger burst and four generations a minute sustained. Still a cap:
 * a compromised account should not be able to spend without limit either.
 */
export const GENERATE_USER: RateLimitPolicy = {
  scope: "generate:user",
  capacity: 20,
  refillPerSecond: 1 / 15,
};

/**
 * `/api/health` is unauthenticated by design (it has to work when auth is
 * broken) and does one bounded `SELECT 1`, so it's cheap — but still not free,
 * and unauthenticated + no per-caller identity beyond IP is exactly the shape
 * worth capping against a monitoring misconfiguration or a scripted hammer.
 * Generous relative to GENERATE_GUEST since legitimate uptime monitors poll
 * every few seconds from a small number of source IPs.
 */
export const HEALTH: RateLimitPolicy = {
  scope: "health",
  capacity: 30,
  refillPerSecond: 1,
};

/**
 * Registration is cheap to serve but attractive to automate. ADR 0011 closed the
 * response and timing enumeration channels here and noted that, without a rate
 * limit, an attacker with unlimited attempts retains other avenues. This is that
 * limit.
 */
export const REGISTER: RateLimitPolicy = {
  scope: "register",
  capacity: 5,
  refillPerSecond: 1 / 60,
};

/**
 * Reads are cheap (an indexed select, no provider call) and can be generous —
 * a library or feed page load fires one, and paging through it fires a handful
 * more in quick succession. Both `/api/stories` GET and `/api/stories/[id]` GET
 * require a session already, so identity is always the account.
 */
export const STORIES_READ: RateLimitPolicy = {
  scope: "stories:read",
  capacity: 60,
  refillPerSecond: 1,
};

/**
 * Writes cost more (an insert, or an update plus the ownership select before
 * it) and happen rarely in a real session — starting a story, toggling
 * `isShared`, changing `targetLength`. A handful per minute covers every real
 * pattern while bounding a scripted insert flood.
 */
export const STORIES_WRITE: RateLimitPolicy = {
  scope: "stories:write",
  capacity: 10,
  refillPerSecond: 1 / 10,
};

/** Same shape as STORIES_READ — browsing/paginating the shared feed. */
export const FEED_READ: RateLimitPolicy = {
  scope: "feed:read",
  capacity: 60,
  refillPerSecond: 1,
};

/**
 * The strictest policy in the file. A real reader reports a story at most once
 * or twice, ever — the unique `(storyId, reporterId)` constraint already makes
 * a repeat report a no-op — but every call still writes a row before that
 * constraint is checked, so this is the one read-adjacent-cost route that must
 * not be generous.
 */
export const REPORT: RateLimitPolicy = {
  scope: "report",
  capacity: 3,
  refillPerSecond: 1 / 600,
};

/**
 * The resume endpoint (docs/adr/0043) is a Redis read with no provider call
 * behind it, invoked only on a recovery path (a client reconnecting after a
 * drop), not on every turn — generous relative to GENERATE_GUEST/GENERATE_USER
 * for that reason, same identity split (account when signed in, else address).
 */
export const RESUME_GUEST: RateLimitPolicy = {
  scope: "resume:guest",
  capacity: 20,
  refillPerSecond: 1 / 10,
};

export const RESUME_USER: RateLimitPolicy = {
  scope: "resume:user",
  capacity: 40,
  refillPerSecond: 1 / 5,
};

/**
 * Number of trusted hops between the caller and this app that append to
 * `x-forwarded-for` on the way in. Vercel is one hop, appending exactly once;
 * a self-hosted deployment with its own ingress in front of Vercel (or another
 * proxy) would be two. Configurable rather than hardcoded because this is a
 * deployment-topology fact this codebase cannot know on its own.
 */
function trustedProxyHopCount(): number {
  const raw = process.env.TRUSTED_PROXY_HOP_COUNT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The client address, read from the proxy headers the hosting platform sets.
 *
 * `x-forwarded-for` is only as trustworthy as whoever wrote to it last. A
 * proxy that *appends* the address it received the request from (Vercel's
 * behaviour) means every entry added by a hop you control lands on the
 * *right*; anything to the left of that is whatever the caller supplied,
 * including a spoofed value designed to mint a fresh bucket on every request.
 * The old code read the leftmost entry — exactly the attacker-controlled one.
 *
 * Reading the Nth entry from the right, where N is `TRUSTED_PROXY_HOP_COUNT`,
 * is what actually names the real client: with one trusted hop (the default,
 * and Vercel's case) that is the last entry. If the header has fewer entries
 * than the configured hop count, it cannot have been written entirely by
 * infrastructure this deployment controls, so it is treated as absent rather
 * than trusted.
 *
 * Returns `"unknown"` when nothing usable is present (no proxy in front of the
 * app at all — local dev, or a raw request straight to the app). Callers must
 * not treat that string as an individual caller's identity: see
 * `guardGenerate`'s handling of it, which applies a much stricter, shared
 * ceiling instead of the normal per-guest policy — an unidentifiable
 * population is bounded in aggregate rather than pretended to be one caller.
 * Signed-in Writers are unaffected either way: they are keyed by user id.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const hopCount = trustedProxyHopCount();
    const index = parts.length - hopCount;
    if (index >= 0 && parts[index]) return parts[index];
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** The identity `clientIp` falls back to when no proxy header is usable at all. */
export const UNIDENTIFIED_GUEST_IP = "unknown";

/**
 * The bucket key for a request.
 *
 * Addresses are hashed rather than stored: the table would otherwise become a
 * log of who used the app and when, which is a needless thing to hold for a
 * counter. The hash keeps buckets distinct, which is all the algorithm needs.
 */
export function bucketKey(policy: RateLimitPolicy, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${policy.scope}:${digest}`;
}

/**
 * How long until one token is available, given the tokens a bucket held at
 * `tokensAt` — always at least a second, so a client that honours Retry-After
 * cannot spin.
 */
export function retryAfterSeconds(
  policy: RateLimitPolicy,
  tokens: number,
  secondsSince: number
): number {
  const projected = Math.min(policy.capacity, tokens + secondsSince * policy.refillPerSecond);
  if (projected >= 1) return 1;
  return Math.max(1, Math.ceil((1 - projected) / policy.refillPerSecond));
}
