import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rateLimitBuckets } from "@/lib/db/schema";
import { consumeToken, tooManyRequests } from "./store";
import { bucketKey, type RateLimitPolicy } from "./policy";

/**
 * The limiter against a real Postgres. The property under test is that the
 * refill, the check, and the decrement happen as one atomic step — which is a
 * claim about what the database does with two conflicting upserts, and cannot be
 * demonstrated against a stub.
 */

/** Small and slow to refill, so exhaustion is reachable inside a test. */
const TINY: RateLimitPolicy = { scope: "test-tiny", capacity: 3, refillPerSecond: 1 / 60 };

/** Refills a token every 100ms, for observing recovery without a long wait. */
const BRISK: RateLimitPolicy = { scope: "test-brisk", capacity: 2, refillPerSecond: 10 };

async function bucket(policy: RateLimitPolicy, identity: string) {
  const [row] = await getDb()
    .select()
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.key, bucketKey(policy, identity)));
  return row;
}

/** Rewinds a bucket's clock, standing in for time actually passing. */
async function ageBucket(policy: RateLimitPolicy, identity: string, seconds: number) {
  await getDb()
    .update(rateLimitBuckets)
    .set({ updatedAt: new Date(Date.now() - seconds * 1000) })
    .where(eq(rateLimitBuckets.key, bucketKey(policy, identity)));
}

describe("consumeToken", () => {
  it("allows a first request and creates the bucket", async () => {
    const result = await consumeToken(getDb(), TINY, "203.0.113.7");

    expect(result).toEqual({ allowed: true, remaining: 2 });
    expect(await bucket(TINY, "203.0.113.7")).toBeDefined();
  });

  it("allows exactly the burst, then denies", async () => {
    const results = [];
    for (let i = 0; i < TINY.capacity + 2; i++) {
      results.push(await consumeToken(getDb(), TINY, "203.0.113.7"));
    }

    expect(results.filter((r) => r.allowed)).toHaveLength(TINY.capacity);
    expect(results.slice(TINY.capacity).every((r) => !r.allowed)).toBe(true);
  });

  it("tells a denied caller when to come back", async () => {
    for (let i = 0; i < TINY.capacity; i++) await consumeToken(getDb(), TINY, "203.0.113.7");

    const denied = await consumeToken(getDb(), TINY, "203.0.113.7");

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      // One token per minute, and the bucket was just emptied.
      expect(denied.retryAfterSeconds).toBeGreaterThan(30);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("keeps separate callers on separate budgets", async () => {
    for (let i = 0; i < TINY.capacity; i++) await consumeToken(getDb(), TINY, "203.0.113.7");

    const other = await consumeToken(getDb(), TINY, "203.0.113.8");

    expect(other.allowed).toBe(true);
  });

  it("refills over elapsed time rather than resetting on a window boundary", async () => {
    // A fixed window lets a caller spend a full budget at the end of one window
    // and another at the start of the next. A bucket has no boundary to exploit.
    for (let i = 0; i < BRISK.capacity; i++) await consumeToken(getDb(), BRISK, "203.0.113.7");
    expect((await consumeToken(getDb(), BRISK, "203.0.113.7")).allowed).toBe(false);

    await ageBucket(BRISK, "203.0.113.7", 0.15); // 1.5 tokens' worth

    expect((await consumeToken(getDb(), BRISK, "203.0.113.7")).allowed).toBe(true);
  });

  it("never refills past the burst capacity", async () => {
    // Otherwise an account idle for a week would accrue a week of tokens and be
    // able to spend them all at once.
    await consumeToken(getDb(), TINY, "203.0.113.7");
    await ageBucket(TINY, "203.0.113.7", 60 * 60 * 24 * 7);

    await consumeToken(getDb(), TINY, "203.0.113.7");

    const row = await bucket(TINY, "203.0.113.7");
    expect(Number(row.tokens)).toBeLessThanOrEqual(TINY.capacity - 1);
  });

  it("does not spend a token on a request it denies", async () => {
    for (let i = 0; i < TINY.capacity; i++) await consumeToken(getDb(), TINY, "203.0.113.7");
    const afterExhaustion = Number((await bucket(TINY, "203.0.113.7")).tokens);

    await consumeToken(getDb(), TINY, "203.0.113.7");

    // A denial that still decremented would push the bucket further negative on
    // every retry and turn a brief limit into an escalating lockout.
    expect(Number((await bucket(TINY, "203.0.113.7")).tokens)).toBe(afterExhaustion);
  });

  it("hands out no more than the capacity under simultaneous requests", async () => {
    // The reason this is one statement. Read-then-write across two statements is
    // the same TOCTOU that duplicated paragraph positions: every concurrent
    // caller reads "tokens remaining" before any of them writes, and they all
    // proceed. Postgres serialises conflicting upserts on the primary key, so
    // each one re-evaluates against the row the previous one actually wrote.
    const attempts = Array.from({ length: 20 }, () => consumeToken(getDb(), TINY, "203.0.113.7"));

    const results = await Promise.all(attempts);

    expect(results.filter((r) => r.allowed)).toHaveLength(TINY.capacity);
    const row = await bucket(TINY, "203.0.113.7");
    expect(Number(row.tokens)).toBeGreaterThanOrEqual(0);
    expect(Number(row.tokens)).toBeLessThan(1);
  });
});

describe("tooManyRequests", () => {
  it("sends Retry-After so a well-behaved client knows to wait", async () => {
    const response = tooManyRequests({ retryAfterSeconds: 42 }, "slow down");

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "slow down" });
  });
});
