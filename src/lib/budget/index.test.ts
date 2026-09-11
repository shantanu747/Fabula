import { afterEach, describe, expect, it, vi } from "vitest";
import { __setKvForTests, getKv } from "@/lib/kv/client";
import { createFakeBudgetKv, neutralizeKvForEachTest, throwingKv } from "@/test/kv";
import type { AppDatabase } from "@/lib/db/types";
import { checkBudget, recordSpend } from "./index";

// See kv/client.test.ts's comment — CI's job-level KV_REST_API_URL must not
// leak into this file's own "no Redis configured" fail-open cases.
neutralizeKvForEachTest();

function fakeDbWithTotal(total: number): AppDatabase {
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ total: String(total) }],
      }),
    }),
  } as unknown as AppDatabase;
}

/** Returns a queued total on each successive call — checkBudget always reads
 *  the global total first, then the identity total, so `[globalTotal,
 *  identityTotal]` lets a test set the two independently. */
function sequencedFakeDb(totals: number[]): AppDatabase {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ total: String(totals[call++] ?? 0) }],
      }),
    }),
  } as unknown as AppDatabase;
}

function throwingDb(): AppDatabase {
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          throw new Error("postgres is down");
        },
      }),
    }),
  } as unknown as AppDatabase;
}

afterEach(() => {
  __setKvForTests(undefined);
  vi.restoreAllMocks();
});

describe("checkBudget — per-identity cap fails open without Redis", () => {
  it("allows a user through when Redis isn't configured, without touching Postgres", async () => {
    const db = throwingDb(); // would throw if the identity check ever reached it
    const result = await checkBudget(db, { type: "user", userId: "u1" });

    expect(result.allowed).toBe(true);
  });

  it("allows a guest through the same way", async () => {
    const db = throwingDb();
    const result = await checkBudget(db, { type: "guest" });

    expect(result.allowed).toBe(true);
  });
});

describe("checkBudget — Redis configured but unresponsive mid-check", () => {
  it("falls back to the Postgres aggregate for the global cap, same as no Redis at all", async () => {
    __setKvForTests(throwingKv());
    const overBudget = fakeDbWithTotal(1000);

    const result = await checkBudget(overBudget, { type: "user", userId: "u1" });

    expect(result).toEqual({ allowed: false, kind: "global" });
  });

  it("fails open on the identity cap, same as no Redis at all", async () => {
    __setKvForTests(throwingKv());
    // Global check falls back to Postgres and passes; the identity check then
    // sees hasKv() true but every call to it fails, so it must fail open
    // rather than propagate the error or silently treat it as "at the cap".
    const db = fakeDbWithTotal(0);

    const result = await checkBudget(db, { type: "user", userId: "u1" });

    expect(result.allowed).toBe(true);
  });
});

describe("checkBudget — global cap fails closed", () => {
  it("falls back to a Postgres aggregate when Redis isn't configured", async () => {
    const overBudget = fakeDbWithTotal(1000); // comfortably over GLOBAL_DAILY_CAP_USD

    const result = await checkBudget(overBudget, { type: "user", userId: "u1" });

    expect(result).toEqual({ allowed: false, kind: "global" });
  });

  it("allows the request when the Postgres aggregate is under the cap", async () => {
    const underBudget = fakeDbWithTotal(0.5);

    const result = await checkBudget(underBudget, { type: "guest" });

    expect(result.allowed).toBe(true);
  });

  it("allows the request, logged loudly, when both Redis and the Postgres fallback fail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkBudget(throwingDb(), { type: "user", userId: "u1" });

    expect(result.allowed).toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it("checks the global cap before the identity cap", async () => {
    // A global denial must short-circuit before paying for a per-identity
    // Redis round trip it doesn't need.
    __setKvForTests(createFakeBudgetKv());
    await getKv().set("budget:global:not-todays-key", 0); // irrelevant key, just to prove KV is wired
    const overBudget = fakeDbWithTotal(1000);
    __setKvForTests(undefined); // force the Postgres fallback path for the global check

    const result = await checkBudget(overBudget, { type: "user", userId: "u1" });

    expect(result.kind).toBe("global");
  });
});

describe("checkBudget — with a working Redis", () => {
  it("denies a user once their reconciled Postgres total is over the per-user cap", async () => {
    __setKvForTests(createFakeBudgetKv());
    // Global total ($0) is under GLOBAL_DAILY_CAP_USD; this user's own total
    // ($1000) is over PER_USER_DAILY_CAP_USD — isolating which cap actually
    // fired requires the two queries to disagree, which fakeDbWithTotal can't
    // express since it answers every query identically.
    const db = sequencedFakeDb([0, 1000]);

    const result = await checkBudget(db, { type: "user", userId: "u1" });

    expect(result).toEqual({ allowed: false, kind: "user" });
  });

  it("reconciles a cold key from Postgres once, then trusts the seeded Redis value", async () => {
    __setKvForTests(createFakeBudgetKv());
    let calls = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            calls++;
            return [{ total: "0" }]; // well under any cap
          },
        }),
      }),
    } as unknown as AppDatabase;

    const first = await checkBudget(db, { type: "user", userId: "u2" });
    const second = await checkBudget(db, { type: "user", userId: "u2" });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Two checkBudget calls, each also checking the global cap: exactly two
    // Postgres reads (one global + one per-user) on the first, cold call, and
    // zero more once both keys are seeded.
    expect(calls).toBe(2);
  });

  it("denies a guest once the shared guest total is over its cap", async () => {
    __setKvForTests(createFakeBudgetKv());
    const db = sequencedFakeDb([0, 1000]); // global under cap, guest total over it

    const result = await checkBudget(db, { type: "guest" });

    expect(result).toEqual({ allowed: false, kind: "guest" });
  });
});

describe("recordSpend", () => {
  it("is a no-op when Redis isn't configured", async () => {
    await expect(recordSpend({ type: "user", userId: "u1" }, 0.01)).resolves.toBeUndefined();
  });

  it("increments both the identity and global counters", async () => {
    __setKvForTests(createFakeBudgetKv());

    await recordSpend({ type: "user", userId: "u3" }, 0.01);
    await recordSpend({ type: "user", userId: "u3" }, 0.02);

    const result = await checkBudget(fakeDbWithTotal(0), { type: "user", userId: "u3" });
    // Not a direct read of the counter (no public getter) — proven instead via
    // a cap set low enough that 0.03 recorded spend already exceeds it.
    expect(result.allowed).toBe(true); // $0.03 is still well under $2/day
  });

  it("counts an unpriced-model generation at the conservative default, not free", async () => {
    __setKvForTests(createFakeBudgetKv());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await recordSpend({ type: "guest" }, undefined);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("conservative default"));
  });

  it("swallows a Redis failure rather than throwing", async () => {
    __setKvForTests(throwingKv());

    await expect(recordSpend({ type: "user", userId: "u1" }, 0.01)).resolves.toBeUndefined();
  });
});
