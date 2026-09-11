import { describe, expect, it } from "vitest";
import { formatTable, percentile, percentiles, summarize, type RunMetrics } from "./report";

describe("percentile", () => {
  it("throws on empty input", () => {
    expect(() => percentile([], 0.5)).toThrow(/no samples/);
  });

  it("returns the only value for a single sample, at any percentile", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
  });

  it("matches hand-computed values against a sorted 10-sample set", () => {
    // 1..10; p50 rank = 0.5*9 = 4.5 -> interpolate index 4,5 (values 5,6) -> 5.5
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBeCloseTo(5.5);
    // p99 rank = 0.99*9 = 8.91 -> interpolate index 8,9 (values 9,10) -> 9 + 0.91*1 = 9.91
    expect(percentile(values, 0.99)).toBeCloseTo(9.91);
    // p0 and p1 are exactly the min/max
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(10);
  });

  it("sorts unsorted input rather than trusting call order", () => {
    const unsorted = [10, 1, 5, 3, 8, 2, 9, 4, 7, 6];
    expect(percentile(unsorted, 0.5)).toBeCloseTo(5.5);
    expect(percentile(unsorted, 0)).toBe(1);
    expect(percentile(unsorted, 1)).toBe(10);
  });

  it("does not silently collapse to the max for p99 with fewer than 100 samples", () => {
    // 5 samples: p99 rank = 0.99*4 = 3.96 -> interpolates between index 3 and 4
    // (values 4 and 5), NOT simply "return the max" — it's 4.96, distinguishably
    // less than 5 despite being close to it.
    const values = [1, 2, 3, 4, 5];
    const p99 = percentile(values, 0.99);
    expect(p99).toBeCloseTo(4.96);
    expect(p99).toBeLessThan(5);
  });

  it("rejects an out-of-range percentile", () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(/must be within/);
    expect(() => percentile([1, 2, 3], -0.1)).toThrow(/must be within/);
  });
});

describe("percentiles", () => {
  it("computes p50/p95/p99 together", () => {
    const result = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.p50).toBeCloseTo(5.5);
    expect(result.p95).toBeCloseTo(9.55);
    expect(result.p99).toBeCloseTo(9.91);
  });
});

function baseMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    writers: 2,
    turns: 2,
    rampMs: 100,
    mockChunkDelayMs: 15,
    identity: "shared-authenticated",
    wallMs: 1000,
    samples: [],
    roundTrips: [],
    ...overrides,
  };
}

describe("summarize", () => {
  it("separates successes from errors and reports throughput over wall time", () => {
    const metrics = baseMetrics({
      wallMs: 2000,
      samples: [
        { writerId: 0, turn: 0, ttftMs: 10, totalMs: 50, status: 200, storySoFarBytes: 100 },
        { writerId: 0, turn: 1, ttftMs: 12, totalMs: 55, status: 200, storySoFarBytes: 200 },
        { writerId: 1, turn: 0, totalMs: 2, status: 429, storySoFarBytes: 50 },
      ],
    });
    const summary = summarize(metrics);
    expect(summary.totalCalls).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.errorsByStatus).toEqual({ 429: 1 });
    expect(summary.ttftMs?.p50).toBeCloseTo(11);
    // 2 successes over 2 seconds wall time
    expect(summary.throughputPerSec).toBeCloseTo(1);
  });

  it("excludes fast-failing rejections from turn duration, not just from TTFT", () => {
    // A 429 returns almost instantly (the rate limiter rejects before any
    // provider or persistence work happens) — mixing its latency into "turn
    // duration" would make the metric answer "how fast do rejections happen"
    // instead of "how long does a real turn take" once rejections dominate.
    const metrics = baseMetrics({
      samples: [
        { writerId: 0, turn: 0, ttftMs: 400, totalMs: 900, status: 200, storySoFarBytes: 100 },
        { writerId: 1, turn: 0, totalMs: 2, status: 429, storySoFarBytes: 100 },
        { writerId: 2, turn: 0, totalMs: 1, status: 429, storySoFarBytes: 100 },
      ],
    });
    const summary = summarize(metrics);
    expect(summary.turnDurationMs?.p50).toBe(900);
    // storySoFarBytes, unlike turn duration, IS over every call — the upload
    // happens before the server decides to reject it.
    expect(summary.storySoFarBytes?.p50).toBe(100);
  });

  it("reports ttftMs as undefined when nothing ever streamed a first byte", () => {
    const metrics = baseMetrics({
      samples: [{ writerId: 0, turn: 0, totalMs: 5, status: 429, storySoFarBytes: 10 }],
    });
    const summary = summarize(metrics);
    expect(summary.ttftMs).toBeUndefined();
  });
});

describe("formatTable", () => {
  it("renders a human-readable table without throwing on an empty run", () => {
    const metrics = baseMetrics();
    const table = formatTable(metrics, summarize(metrics));
    expect(table).toContain("Fabula capacity benchmark");
    expect(table).toContain("n/a (no samples)");
  });
});
