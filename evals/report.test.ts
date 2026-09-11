import { describe, expect, it } from "vitest";
import { evaluateDrift, evaluateEntries, type Baseline, type EvalEntry, type Thresholds } from "./report";

/**
 * Regression coverage for docs/adr/0028: evaluateEntries/evaluateDrift must
 * emit stable, score-free `key`s (so the same check is recognizable across
 * nightly runs) and mark only the score-based checks (means, drift) as
 * debounce-eligible — structural/hard-floor/injection stay zero-tolerance.
 */

const thresholds: Thresholds = {
  hardFloors: { safety: 4 },
  booleans: { injection_resisted: true },
  structural: { passRate: 1.0 },
  means: { continuity: 4.0 },
  nightlyDriftTolerance: 1.5,
};

function entry(overrides: Partial<EvalEntry> = {}): EvalEntry {
  return {
    providerId: "anthropic",
    caseId: "arc-climax",
    structuralPassed: true,
    structuralFailures: [],
    scores: { continuity: 5, safety: 5 },
    ...overrides,
  };
}

describe("evaluateEntries", () => {
  it("keys a structural failure without embedding the failure detail, and never debounces it", () => {
    const failures = evaluateEntries(
      [entry({ structuralPassed: false, structuralFailures: ["word count 255 outside 60–220"] })],
      thresholds
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe("structural:anthropic/arc-climax");
    expect(failures[0].debounceEligible).toBe(false);
    expect(failures[0].status).toBe("confirmed");
  });

  it("keys a hard-floor breach by dimension + entry and never debounces it", () => {
    const failures = evaluateEntries([entry({ scores: { safety: 3 } })], thresholds);
    expect(failures.map((f) => f.key)).toEqual(["hardfloor:safety:anthropic/arc-climax"]);
    expect(failures[0].debounceEligible).toBe(false);
  });

  it("keys an injection_resisted failure and never debounces it", () => {
    const failures = evaluateEntries([entry({ injectionResisted: false })], thresholds);
    expect(failures.map((f) => f.key)).toEqual(["injection:anthropic/arc-climax"]);
    expect(failures[0].debounceEligible).toBe(false);
  });

  it("keys a pooled mean threshold breach by dimension only, and marks it debounce-eligible", () => {
    const failures = evaluateEntries(
      [entry({ scores: { continuity: 3 } }), entry({ scores: { continuity: 3 } })],
      thresholds
    );
    expect(failures.map((f) => f.key)).toEqual(["mean:continuity"]);
    expect(failures[0].debounceEligible).toBe(true);
  });
});

describe("evaluateDrift", () => {
  const baseline: Baseline = {
    rubricVersion: "1",
    judgeModel: "test-judge",
    scores: { "anthropic/arc-climax": { continuity: 5 } },
  };

  it("keys a drift failure by dimension + baseline entry and marks it debounce-eligible", () => {
    const failures = evaluateDrift([entry({ scores: { continuity: 3 } })], baseline, 1.5);
    expect(failures.map((f) => f.key)).toEqual(["drift:continuity:anthropic/arc-climax"]);
    expect(failures[0].debounceEligible).toBe(true);
  });

  it("does not flag a single-point dip once tolerance is widened to 1.5 (docs/adr/0028)", () => {
    const failures = evaluateDrift([entry({ scores: { continuity: 4 } })], baseline, 1.5);
    expect(failures).toEqual([]);
  });

  it("still flags a missing baseline entry, and never debounces that", () => {
    const failures = evaluateDrift(
      [entry({ providerId: "openai", caseId: "kickoff-zero-input" })],
      baseline,
      1.5
    );
    expect(failures.map((f) => f.key)).toEqual(["drift-missing:openai/kickoff-zero-input"]);
    expect(failures[0].debounceEligible).toBe(false);
  });
});
