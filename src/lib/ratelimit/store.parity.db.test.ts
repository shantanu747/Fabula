import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "@upstash/redis";
import { getDb } from "@/lib/db/client";
import { __setKvForTests } from "@/lib/kv/client";
import { consumeToken } from "./store";
import type { RateLimitPolicy } from "./policy";

/**
 * The parity discipline ADR 0014 applies to the two database drivers, applied
 * here to the two rate-limit backends (docs/adr/0035): the same table of
 * cases run against both, so they cannot silently drift apart. Needs a real
 * Postgres (this file's `.db.test.ts` name puts it in the `db` Vitest
 * project) *and* a real Redis reachable at `KV_REST_API_URL` — this project's
 * local `serverless-redis-http` container (README's "Developing against
 * local Redis") gives the exact same REST protocol Upstash does, the same
 * reasoning that put the Neon HTTP proxy in front of local Postgres for the
 * `db` project generally.
 */

const TINY: RateLimitPolicy = { scope: "parity-tiny", capacity: 3, refillPerSecond: 1 / 60 };
// Refills one token every 500ms — slow enough that the handful of sequential
// awaits this test makes against a real network round trip (local Redis over
// HTTP, not an in-process Postgres pool) can't accidentally refill a token
// before the "still denied" assertion runs, the way store.db.test.ts's
// Postgres-only BRISK (10/s, 100ms/token) safely can.
const BRISK: RateLimitPolicy = { scope: "parity-brisk", capacity: 2, refillPerSecond: 2 };

function runSharedBucketBehavior(label: string) {
  it(`[${label}] allows exactly the burst, then denies`, async () => {
    const identity = `${label}-${crypto.randomUUID()}`;
    const results = [];
    for (let i = 0; i < TINY.capacity + 2; i++) {
      results.push(await consumeToken(getDb(), TINY, identity));
    }
    expect(results.filter((r) => r.allowed)).toHaveLength(TINY.capacity);
    expect(results.slice(TINY.capacity).every((r) => !r.allowed)).toBe(true);
  });

  it(`[${label}] refills over elapsed time rather than resetting on a window boundary`, async () => {
    const identity = `${label}-${crypto.randomUUID()}`;
    for (let i = 0; i < BRISK.capacity; i++) await consumeToken(getDb(), BRISK, identity);
    expect((await consumeToken(getDb(), BRISK, identity)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 750)); // 1.5 tokens' worth at 2/s

    expect((await consumeToken(getDb(), BRISK, identity)).allowed).toBe(true);
  });

  it(`[${label}] keeps separate callers on separate budgets`, async () => {
    const a = `${label}-a-${crypto.randomUUID()}`;
    const b = `${label}-b-${crypto.randomUUID()}`;
    for (let i = 0; i < TINY.capacity; i++) await consumeToken(getDb(), TINY, a);

    expect((await consumeToken(getDb(), TINY, b)).allowed).toBe(true);
  });

  it(`[${label}] does not spend a token on a request it denies`, async () => {
    const identity = `${label}-${crypto.randomUUID()}`;
    for (let i = 0; i < TINY.capacity; i++) await consumeToken(getDb(), TINY, identity);

    const first = await consumeToken(getDb(), TINY, identity);
    const second = await consumeToken(getDb(), TINY, identity);

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    if (!first.allowed && !second.allowed) {
      expect(second.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
    }
  });
}

describe("consumeToken backend parity", () => {
  let savedUrl: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.KV_REST_API_URL;
    savedToken = process.env.KV_REST_API_TOKEN;
    if (!savedUrl || !savedToken) {
      throw new Error(
        "The ratelimit parity suite needs a real Redis. Set KV_REST_API_URL/KV_REST_API_TOKEN " +
          "at a local serverless-redis-http instance — see README's \"Developing against local Redis\"."
      );
    }
  });

  afterEach(() => {
    __setKvForTests(undefined);
    if (savedUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = savedUrl;
    if (savedToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = savedToken;
  });

  describe("redis backend", () => {
    beforeEach(() => {
      __setKvForTests(new Redis({ url: savedUrl!, token: savedToken! }));
    });

    runSharedBucketBehavior("redis");
  });

  describe("postgres fallback backend", () => {
    beforeEach(() => {
      // Forces hasKv() false regardless of env, so consumeToken falls through
      // to consumeTokenPostgres — the same technique guard.test.ts uses for
      // DATABASE_URL, applied to the KV equivalent.
      __setKvForTests(undefined);
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    });

    runSharedBucketBehavior("postgres");
  });
});
