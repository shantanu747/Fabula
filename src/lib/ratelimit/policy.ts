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
 * The client address, read from the proxy headers the hosting platform sets.
 *
 * The leftmost x-forwarded-for entry is the original client *only* when a
 * trusted proxy rewrites the header on the way in, which is the case on Vercel
 * and behind any correctly configured ingress. Self-hosted behind something that
 * merely appends, a caller can spoof the left entry and mint themselves fresh
 * buckets — in that deployment this must read from the right instead, counting
 * back the number of proxies. Signed-in Writers are unaffected either way: they
 * are keyed by user id.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

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
