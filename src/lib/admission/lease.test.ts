import { describe, expect, it } from "vitest";
import { __setKvForTests } from "@/lib/kv/client";
import { createFakeAdmissionKv, neutralizeKvForEachTest, throwingKv } from "@/test/kv";
import { acquireLease } from "./lease";

// See kv/client.test.ts's comment — CI's job-level KV_REST_API_URL must not
// leak into this file's "fails open with nothing configured" cases.
neutralizeKvForEachTest();

describe("acquireLease — fails open (docs/adr/0035)", () => {
  it("acquires with a no-op release when Redis isn't configured at all", async () => {
    const result = await acquireLease("writer-1");

    expect(result.acquired).toBe(true);
    if (result.acquired) await expect(result.release()).resolves.toBeUndefined();
  });

  it("acquires when Redis is configured but throws on every call", async () => {
    __setKvForTests(throwingKv());

    const result = await acquireLease("writer-1");

    expect(result.acquired).toBe(true);
    // Bounding concurrency is a cost optimisation, not the product — a Redis
    // outage must never stop people writing (docs/plans/v4/02-admission-control.md).
    if (result.acquired) await expect(result.release()).resolves.toBeUndefined();
  });
});

describe("acquireLease — with a working backend", () => {
  it("enforces the per-identity cap, independent of other identities", async () => {
    __setKvForTests(createFakeAdmissionKv());

    const first = await acquireLease("writer-1");
    const second = await acquireLease("writer-1");
    const third = await acquireLease("writer-1");
    const other = await acquireLease("writer-2");

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(third.acquired).toBe(false);
    expect(other.acquired).toBe(true);
  });

  it("reports a short, fixed Retry-After on refusal rather than a computed one", async () => {
    __setKvForTests(createFakeAdmissionKv());
    await acquireLease("writer-1");
    await acquireLease("writer-1");

    const refused = await acquireLease("writer-1");

    expect(refused).toEqual({ acquired: false, retryAfterSeconds: 5 });
  });

  it("frees a slot on release, letting a subsequent acquire succeed", async () => {
    __setKvForTests(createFakeAdmissionKv());
    const first = await acquireLease("writer-1");
    await acquireLease("writer-1");
    const blocked = await acquireLease("writer-1");
    expect(blocked.acquired).toBe(false);

    if (first.acquired) await first.release();

    expect((await acquireLease("writer-1")).acquired).toBe(true);
  });

  it("is idempotent — releasing twice does not free two slots", async () => {
    __setKvForTests(createFakeAdmissionKv());
    const first = await acquireLease("writer-1");
    await acquireLease("writer-1");

    if (first.acquired) {
      await first.release();
      await first.release(); // second call must be a no-op
    }

    // Only one slot was actually freed, so exactly one of the next two
    // acquisitions succeeds — a double-release would have freed two.
    const a = await acquireLease("writer-1");
    const b = await acquireLease("writer-1");
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
  });
});
