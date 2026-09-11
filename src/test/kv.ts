import { afterEach, beforeEach } from "vitest";
import type { Redis } from "@upstash/redis";
import { __setKvForTests } from "@/lib/kv/client";

/**
 * Call at the top of a `db.test.ts` file that specifically exercises the
 * Postgres fallback path and must not be affected by a real Redis happening
 * to be configured for the run (this repo's local `serverless-redis-http`,
 * wired in for `store.parity.db.test.ts` and `lease.db.test.ts`). Without
 * this, `hasKv()` reporting true would silently redirect these tests' calls
 * to Redis instead of the Postgres behaviour they're named for and assert on
 * directly against `rate_limit_bucket` rows.
 */
export function neutralizeKvForEachTest(): void {
  let savedUrl: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.KV_REST_API_URL;
    savedToken = process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    __setKvForTests(undefined);
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = savedUrl;
    if (savedToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = savedToken;
    __setKvForTests(undefined);
  });
}

/**
 * A KV handle that throws on every call, for proving the "Redis absent, slow,
 * or erroring never breaks the app" claim (docs/adr/0035) — without this test,
 * that claim is just a comment. A Proxy rather than a hand-listed stub: the
 * property under test is "throws on *every* call", and a stub with a fixed
 * method list would silently stop proving that the day a caller starts using
 * a method the stub never anticipated.
 */
export function throwingKv(): Redis {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error("kv unavailable (test double)");
        };
      },
    }
  ) as unknown as Redis;
}

/**
 * An in-memory stand-in for the admission module's two Lua scripts
 * (`src/lib/admission/lease.ts`), for route.test.ts's acquisitions-minus-
 * releases assertions across all five of route.ts's terminal paths — the
 * same "in-memory fake standing in for the real backend" technique the
 * existing `InMemorySpanExporter` OTel tests already use for span lifetime.
 *
 * Distinguishes the acquire script from the release script by a substring
 * unique to each rather than object identity, so this fake doesn't need
 * lease.ts to export its script constants just to be testable against.
 * TTL is accepted and ignored — no test using this fake exercises expiry;
 * that property is proven against a real Redis instead (lease.db.test.ts).
 */
export type FakeAdmissionKv = Redis & { counts: Map<string, number> };

export function createFakeAdmissionKv(): FakeAdmissionKv {
  const counts = new Map<string, number>();

  function eval_(script: string, keys: string[], args: string[]): number {
    if (script.includes("identityCap")) {
      const [identityKey, globalKey] = keys;
      const [identityCap, globalCap] = args.map(Number);
      const identityCount = counts.get(identityKey) ?? 0;
      const globalCount = counts.get(globalKey) ?? 0;
      if (identityCount >= identityCap || globalCount >= globalCap) return 0;
      counts.set(identityKey, identityCount + 1);
      counts.set(globalKey, globalCount + 1);
      return 1;
    }
    if (script.includes("DECR")) {
      const [key] = keys;
      const count = counts.get(key) ?? 0;
      if (count > 0) counts.set(key, count - 1);
      return 1;
    }
    throw new Error(`createFakeAdmissionKv: unrecognised script:\n${script}`);
  }

  return { eval: eval_, counts } as unknown as FakeAdmissionKv;
}

/**
 * An in-memory stand-in for the plain get/set/incrbyfloat/expire commands the
 * budget module (`src/lib/budget/`) uses — no Lua script involved there
 * (unlike admission's atomic check-and-increment), so a direct reimplementation
 * of each command's real semantics is enough to trust, unlike the admission
 * fake's script-dispatch approach.
 */
export function createFakeBudgetKv(): Redis {
  const store = new Map<string, number>();

  return {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    set: async (key: string, value: number) => {
      store.set(key, value);
      return "OK";
    },
    incrbyfloat: async (key: string, amount: number) => {
      const next = (store.get(key) ?? 0) + amount;
      store.set(key, next);
      return next;
    },
    expire: async () => 1,
  } as unknown as Redis;
}
