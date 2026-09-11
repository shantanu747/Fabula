import { describe, expect, it } from "vitest";
import { consumeToken } from "./store";
import { GENERATE_GUEST } from "./policy";
import type { AppDatabase } from "@/lib/db/types";
import { __setKvForTests } from "@/lib/kv/client";
import { neutralizeKvForEachTest, throwingKv } from "@/test/kv";

/** A db double returning canned results, one per execute call. */
function fakeDb(results: Array<{ rows: unknown[] }>): AppDatabase {
  let call = 0;
  return { execute: async () => results[call++] ?? { rows: [] } } as unknown as AppDatabase;
}

// This file asserts on the Postgres-only path directly (the "degraded reads"
// cases below construct a fake AppDatabase and expect it to be the thing
// consumeToken actually calls) — see kv/client.test.ts's comment on why an
// ambient CI env var must not silently redirect that to Redis.
neutralizeKvForEachTest();

describe("consumeToken — Redis unavailable falls back to Postgres (docs/adr/0035)", () => {
  it("proves the never-authoritative claim: a throwing KV still gets a correct answer from Postgres", async () => {
    __setKvForTests(throwingKv());

    const result = await consumeToken(fakeDb([{ rows: [{ tokens: 2.9 }] }]), GENERATE_GUEST, "1.2.3.4");

    // Identical to the no-KV-configured behaviour below — the caller cannot
    // tell the difference, which is the whole point of the fallback.
    expect(result).toEqual({ allowed: true, remaining: 2 });
  });
});

describe("consumeToken — degraded reads", () => {
  it("falls back to a one-second wait when the bucket has vanished", async () => {
    // The denial and the follow-up read are separate statements, so a bucket
    // swept between them leaves nothing to compute a wait from. One second is
    // the floor the caller can act on, and it is never zero.
    const result = await consumeToken(fakeDb([{ rows: [] }, { rows: [] }]), GENERATE_GUEST, "1.2.3.4");

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("reports whole tokens remaining, rounded down", async () => {
    // A caller with 2.9 tokens has two requests, not three.
    const result = await consumeToken(fakeDb([{ rows: [{ tokens: 2.9 }] }]), GENERATE_GUEST, "1.2.3.4");

    expect(result).toEqual({ allowed: true, remaining: 2 });
  });
});
