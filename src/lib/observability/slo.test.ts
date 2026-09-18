import { describe, expect, it } from "vitest";
import {
  SLOS,
  attainmentFromLatency,
  attainmentFromRate,
  generationSuccessRateAttainment,
  generationTtftAttainment,
  percentile,
  rate,
} from "./slo";

describe("SLOS — definitions", () => {
  it("every definition has a positive target, window, and non-empty rationale", () => {
    expect(SLOS.length).toBeGreaterThan(0);
    for (const def of SLOS) {
      expect(def.id).toBeTruthy();
      expect(def.target).toBeGreaterThan(0);
      expect(def.windowHours).toBeGreaterThan(0);
      expect(def.rationale.length).toBeGreaterThan(20);
    }
  });

  it("has a unique id per definition", () => {
    const ids = SLOS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("percentile", () => {
  it("returns undefined for an empty window — the empty-window case", () => {
    expect(percentile([], 0.95)).toBeUndefined();
  });

  it("returns the single value for a one-element array at any percentile", () => {
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("clamps p<=0 to the minimum and p>=1 to the maximum", () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 1)).toBe(5);
  });

  it("interpolates between the two nearest ranks for a fractional rank", () => {
    // Sorted: [10, 20, 30, 40]; p95 rank = 0.95 * 3 = 2.85 -> between index 2 (30) and 3 (40).
    expect(percentile([40, 10, 30, 20], 0.95)).toBeCloseTo(38.5, 5);
  });

  it("lands exactly on a rank with no interpolation needed", () => {
    // p50 of [10, 20, 30] -> rank 1.0 exactly -> 20.
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
  });
});

describe("rate", () => {
  it("returns undefined for a zero or negative denominator — no attempts, not 0%", () => {
    expect(rate(0, 0)).toBeUndefined();
    expect(rate(5, -1)).toBeUndefined();
  });

  it("divides numerator by denominator otherwise", () => {
    expect(rate(97, 100)).toBe(0.97);
    expect(rate(0, 10)).toBe(0);
  });
});

describe("attainmentFromRate / attainmentFromLatency", () => {
  const rateDef = SLOS.find((d) => d.id === "generation_success_rate")!;
  const latencyDef = SLOS.find((d) => d.id === "generation_ttft_p95")!;

  it("a rate SLO is met at or above target, missed below it", () => {
    expect(attainmentFromRate(rateDef, 0.97).met).toBe(true);
    expect(attainmentFromRate(rateDef, 0.98).met).toBe(true);
    expect(attainmentFromRate(rateDef, 0.96).met).toBe(false);
  });

  it("a rate SLO with no observation reports met: undefined, not false", () => {
    const attainment = attainmentFromRate(rateDef, undefined);
    expect(attainment.met).toBeUndefined();
    expect(attainment.observed).toBeUndefined();
  });

  it("a latency SLO is met at or below target, missed above it (lower is better)", () => {
    expect(attainmentFromLatency(latencyDef, 3000).met).toBe(true);
    expect(attainmentFromLatency(latencyDef, 2000).met).toBe(true);
    expect(attainmentFromLatency(latencyDef, 3001).met).toBe(false);
  });

  it("a latency SLO with no observation reports met: undefined", () => {
    expect(attainmentFromLatency(latencyDef, undefined).met).toBeUndefined();
  });
});

describe("generationSuccessRateAttainment", () => {
  it("excludes cancelled turns from both numerator and denominator", () => {
    const attainment = generationSuccessRateAttainment({
      success: 90,
      persistFailed: 5,
      providerError: 5,
      cancelled: 1000, // would swamp the rate if counted either way
    });

    expect(attainment.observed).toBeCloseTo(0.95, 5);
  });

  it("counts persist_failed toward success — the provider was paid and delivered prose", () => {
    const attainment = generationSuccessRateAttainment({
      success: 0,
      persistFailed: 10,
      providerError: 0,
      cancelled: 0,
    });

    expect(attainment.observed).toBe(1);
  });

  it("reports undefined (not 0%) for an empty window", () => {
    const attainment = generationSuccessRateAttainment({
      success: 0,
      persistFailed: 0,
      providerError: 0,
      cancelled: 0,
    });

    expect(attainment.observed).toBeUndefined();
    expect(attainment.met).toBeUndefined();
  });
});

describe("generationTtftAttainment", () => {
  it("computes p95 over successful generations' TTFT", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const attainment = generationTtftAttainment(values);

    expect(attainment.observed).toBeCloseTo(95.05, 1);
  });

  it("reports undefined for an empty window", () => {
    expect(generationTtftAttainment([]).observed).toBeUndefined();
  });
});
