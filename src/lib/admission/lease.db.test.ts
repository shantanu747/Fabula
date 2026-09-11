import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "@upstash/redis";
import { __setKvForTests } from "@/lib/kv/client";
import { acquireLease } from "./lease";

/**
 * Against a real Redis (this file's `.db.test.ts` name — see
 * store.parity.db.test.ts's comment on why that glob also covers "needs live
 * Redis" in this repo). Two things a hand-written fake cannot prove: that the
 * actual Lua script is syntactically and semantically correct, and that a
 * leaked lease genuinely expires rather than being freed by application code.
 */
describe("acquireLease against a real Redis", () => {
  let savedUrl: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.KV_REST_API_URL;
    savedToken = process.env.KV_REST_API_TOKEN;
    if (!savedUrl || !savedToken) {
      throw new Error(
        "This suite needs a real Redis. Set KV_REST_API_URL/KV_REST_API_TOKEN at a local " +
          'serverless-redis-http instance — see README\'s "Developing against local Redis".'
      );
    }
    __setKvForTests(new Redis({ url: savedUrl, token: savedToken }));
  });

  afterEach(() => {
    __setKvForTests(undefined);
  });

  it("a leaked lease (never released) recovers once its TTL elapses", async () => {
    const identity = `leak-test-${crypto.randomUUID()}`;

    const first = await acquireLease(identity);
    expect(first.acquired).toBe(true);
    const second = await acquireLease(identity);
    expect(second.acquired).toBe(true);
    // The cap (2) is now held, both leases deliberately never released — this
    // is the crash scenario: nothing runs finish()'s release call.
    expect((await acquireLease(identity)).acquired).toBe(false);

    // Override the TTL down to something a test can wait out, rather than
    // waiting out the real production TTL — this is the one substitution
    // this test makes; everything else is the real acquire/release path.
    await new Redis({ url: savedUrl!, token: savedToken! }).expire(`admission:identity:${identity}`, 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const afterExpiry = await acquireLease(identity);
    expect(afterExpiry.acquired).toBe(true);
  });

  it("acquire and release round-trip against the real Lua scripts", async () => {
    const identity = `roundtrip-${crypto.randomUUID()}`;

    const lease = await acquireLease(identity);
    expect(lease.acquired).toBe(true);
    if (lease.acquired) await lease.release();

    // Released for real — the cap (2) is free again from a clean slate.
    const a = await acquireLease(identity);
    const b = await acquireLease(identity);
    const c = await acquireLease(identity);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(false);
  });
});
