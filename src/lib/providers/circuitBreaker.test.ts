import { describe, expect, it } from "vitest";
import { __setKvForTests } from "@/lib/kv/client";
import { createFakeBreakerKv, neutralizeKvForEachTest, throwingKv } from "@/test/kv";
import { checkBreaker, isProviderQuotaError, recordBreakerOutcome } from "./circuitBreaker";

neutralizeKvForEachTest();

describe("checkBreaker / recordBreakerOutcome — fails open (docs/adr/0035)", () => {
  it("allows, not-a-probe, when Redis isn't configured at all", async () => {
    const decision = await checkBreaker("anthropic");
    expect(decision).toEqual({ allowed: true, isProbe: false });
    // Must not throw even with nothing configured.
    await recordBreakerOutcome("anthropic", "failure");
  });

  it("allows when Redis is configured but throws on every call", async () => {
    __setKvForTests(throwingKv());
    const decision = await checkBreaker("anthropic");
    expect(decision).toEqual({ allowed: true, isProbe: false });
    await recordBreakerOutcome("anthropic", "failure");
  });
});

describe("checkBreaker / recordBreakerOutcome — with a working backend", () => {
  it("allows every request while closed (the default state)", async () => {
    __setKvForTests(createFakeBreakerKv());
    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: false });
  });

  it("stays closed after fewer than the threshold's worth of consecutive failures", async () => {
    __setKvForTests(createFakeBreakerKv());
    for (let i = 0; i < 4; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: false });
  });

  it("opens after the Nth consecutive failure and denies immediately", async () => {
    __setKvForTests(createFakeBreakerKv());
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    expect(await checkBreaker("anthropic")).toEqual({ allowed: false });
  });

  it("a success resets the failure count — no false trip from unrelated blips", async () => {
    __setKvForTests(createFakeBreakerKv());
    for (let i = 0; i < 4; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    await recordBreakerOutcome("anthropic", "success");
    for (let i = 0; i < 4; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    // Only 4 consecutive failures since the reset — still closed.
    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: false });
  });

  it("tracks each provider independently", async () => {
    const kv = createFakeBreakerKv();
    __setKvForTests(kv);
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    expect(await checkBreaker("anthropic")).toEqual({ allowed: false });
    expect(await checkBreaker("openai")).toEqual({ allowed: true, isProbe: false });
  });

  it("denies during the cooldown window after opening", async () => {
    const kv = createFakeBreakerKv();
    __setKvForTests(kv);
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    // Simulate a moment just after opening — well inside the 30s cooldown.
    const entry = kv.states.get("breaker:anthropic:state")!;
    entry.openedAt = Date.now();
    expect(await checkBreaker("anthropic")).toEqual({ allowed: false });
  });

  it("lets exactly one probe through once the cooldown has elapsed", async () => {
    const kv = createFakeBreakerKv();
    __setKvForTests(kv);
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    const entry = kv.states.get("breaker:anthropic:state")!;
    entry.openedAt = Date.now() - 31_000; // cooldown (30s) has elapsed

    const first = await checkBreaker("anthropic");
    const second = await checkBreaker("anthropic");
    const third = await checkBreaker("anthropic");

    expect(first).toEqual({ allowed: true, isProbe: true });
    expect(second).toEqual({ allowed: false });
    expect(third).toEqual({ allowed: false });
  });

  it("closes on a successful probe, returning to normal operation", async () => {
    const kv = createFakeBreakerKv();
    __setKvForTests(kv);
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    const entry = kv.states.get("breaker:anthropic:state")!;
    entry.openedAt = Date.now() - 31_000;

    const probe = await checkBreaker("anthropic");
    expect(probe).toEqual({ allowed: true, isProbe: true });

    await recordBreakerOutcome("anthropic", "success");

    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: false });
    // A fresh failure count, not still five-and-open.
    for (let i = 0; i < 4; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: false });
  });

  it("re-opens immediately on a failed probe, restarting the cooldown without needing five more failures", async () => {
    const kv = createFakeBreakerKv();
    __setKvForTests(kv);
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    const entry = kv.states.get("breaker:anthropic:state")!;
    entry.openedAt = Date.now() - 31_000;
    const originalOpenedAt = entry.openedAt;

    const probe = await checkBreaker("anthropic");
    expect(probe).toEqual({ allowed: true, isProbe: true });

    await recordBreakerOutcome("anthropic", "failure");

    // Immediately denied again — the probe's own failure was enough.
    expect(await checkBreaker("anthropic")).toEqual({ allowed: false });
    // And the cooldown restarted from the probe's failure, not the original open.
    const reopenedAt = kv.states.get("breaker:anthropic:state")!.openedAt!;
    expect(reopenedAt).toBeGreaterThan(originalOpenedAt);
  });

  it("releases the probe claim on a failed probe, so a later cooldown can produce a fresh one", async () => {
    const kv = createFakeBreakerKv();
    __setKvForTests(kv);
    for (let i = 0; i < 5; i++) {
      await recordBreakerOutcome("anthropic", "failure");
    }
    kv.states.get("breaker:anthropic:state")!.openedAt = Date.now() - 31_000;
    await checkBreaker("anthropic"); // becomes the probe
    await recordBreakerOutcome("anthropic", "failure"); // probe fails, re-opens

    kv.states.get("breaker:anthropic:state")!.openedAt = Date.now() - 31_000; // cooldown elapses again
    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: true });
  });
});

describe("isProviderQuotaError", () => {
  it("recognises a 429 status on a thrown SDK-shaped error", () => {
    expect(isProviderQuotaError({ status: 429 })).toBe(true);
  });

  it("rejects a non-429 status, no status field, and non-object values", () => {
    expect(isProviderQuotaError({ status: 500 })).toBe(false);
    expect(isProviderQuotaError(new Error("boom"))).toBe(false);
    expect(isProviderQuotaError(null)).toBe(false);
    expect(isProviderQuotaError("boom")).toBe(false);
    expect(isProviderQuotaError(undefined)).toBe(false);
  });
});

describe("recordBreakerOutcome — a provider 429 is never recorded (quota, not health)", () => {
  it("a caller that skips recording on 429 leaves the breaker untouched", async () => {
    // circuitBreaker.ts doesn't special-case 429 itself — the caller (route.ts)
    // decides not to call recordBreakerOutcome at all for a quota error. This
    // test documents that contract at the classification boundary; the
    // route-level "never record a 429" behavior is covered where it's wired in.
    __setKvForTests(createFakeBreakerKv());
    expect(isProviderQuotaError({ status: 429 })).toBe(true);
    // No recordBreakerOutcome call — simulating the caller's skip.
    expect(await checkBreaker("anthropic")).toEqual({ allowed: true, isProbe: false });
  });
});
