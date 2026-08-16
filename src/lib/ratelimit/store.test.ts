import { describe, expect, it } from "vitest";
import { consumeToken } from "./store";
import { GENERATE_GUEST } from "./policy";
import type { AppDatabase } from "@/lib/db/types";

/** A db double returning canned results, one per execute call. */
function fakeDb(results: Array<{ rows: unknown[] }>): AppDatabase {
  let call = 0;
  return { execute: async () => results[call++] ?? { rows: [] } } as unknown as AppDatabase;
}

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
