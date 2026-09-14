import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, NETWORK_RETRY_POLICY, parseRetryAfterMs, withBackoff, type BackoffPolicy } from "./retry";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffDelayMs", () => {
  const policy: BackoffPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };

  it("draws uniformly under the exponential cap (full jitter, not base ± wobble)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // attempt 0 -> cap 100, attempt 1 -> cap 200, attempt 2 -> cap 400
    expect(backoffDelayMs(0, policy)).toBe(50);
    expect(backoffDelayMs(1, policy)).toBe(100);
    expect(backoffDelayMs(2, policy)).toBe(200);
  });

  it("clamps the cap at maxDelayMs however large the attempt index gets", () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // draws right at the cap
    expect(backoffDelayMs(10, policy)).toBe(1000);
  });

  it("never returns a negative delay at attempt 0 with a zero random draw", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffDelayMs(0, policy)).toBe(0);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses the delay-seconds form", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses the HTTP-date form as milliseconds from now", () => {
    const future = new Date(Date.now() + 10_000);
    const result = parseRetryAfterMs(future.toUTCString());
    // Allow a small margin — Date.now() advances between construction and parsing.
    expect(result).toBeGreaterThan(9000);
    expect(result).toBeLessThanOrEqual(10_000);
  });

  it("floors an HTTP-date already in the past at zero", () => {
    const past = new Date(Date.now() - 10_000);
    expect(parseRetryAfterMs(past.toUTCString())).toBe(0);
  });

  it("rejects a decimal, a negative number, and scientific notation — RFC 9110 delay-seconds is a bare non-negative integer", () => {
    expect(parseRetryAfterMs("1.5")).toBeUndefined();
    expect(parseRetryAfterMs("-1")).toBeUndefined();
    expect(parseRetryAfterMs("1e3")).toBeUndefined();
  });

  it("returns undefined for a string shaped like an IMF-fixdate but not a real one", () => {
    // Matches the regex shape (three-letter tokens, right digit counts) but
    // "Xxx" is not a real month name, so Date.parse itself must reject it.
    expect(parseRetryAfterMs("Mon, 15 Xxx 2024 10:00:00 GMT")).toBeUndefined();
  });

  it("returns undefined for missing, empty, or garbage input", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("   ")).toBeUndefined();
    expect(parseRetryAfterMs("not-a-header-value")).toBeUndefined();
  });
});

describe("withBackoff", () => {
  const policy: BackoffPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 };

  it("returns the result on the first successful attempt without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const attempt = vi.fn().mockResolvedValue("ok");

    const result = await withBackoff(attempt, () => true, policy, sleep);

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable failure and succeeds, sleeping between attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const attempt = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce("ok");

    const result = await withBackoff(attempt, () => true, policy, sleep);

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("throws the final error once maxAttempts is exhausted, without a sleep after the last attempt", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = new Error("still down");
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(withBackoff(attempt, () => true, policy, sleep)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(policy.maxAttempts);
    expect(sleep).toHaveBeenCalledTimes(policy.maxAttempts - 1);
  });

  it("throws immediately on a non-retryable error, never sleeping or attempting again", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = new Error("turn-violation");
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(withBackoff(attempt, () => false, policy, sleep)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the real setTimeout-backed sleep by default", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce("ok");

    const promise = withBackoff(attempt, () => true, policy);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    vi.useRealTimers();
  });
});

describe("NETWORK_RETRY_POLICY", () => {
  it("is bounded — a few short attempts, not an unbounded or slow retry loop", () => {
    expect(NETWORK_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(3);
    expect(NETWORK_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(5000);
  });
});
