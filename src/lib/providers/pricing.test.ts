import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING } from "./pricing";

describe("estimateCostUsd", () => {
  it.each(Object.entries(PRICING))(
    "computes %s's cost from its published per-MTok rates",
    (model, pricing) => {
      const cost = estimateCostUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(cost).toBeCloseTo(pricing.inputPerMTok + pricing.outputPerMTok, 10);
    }
  );

  it("returns undefined for an unknown model rather than fabricating a cost", () => {
    // Never 0 — 0 would silently under-report cost as if the call were free.
    expect(estimateCostUsd("some-model-nobody-priced", { inputTokens: 500, outputTokens: 500 })).toBeUndefined();
  });

  it("returns 0 for a known model with zero usage", () => {
    // Distinguished from the unknown-model case above: a real $0 for no tokens
    // spent is a fact, not a guess.
    expect(estimateCostUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("scales linearly for a large usage case", () => {
    const cost = estimateCostUsd("gpt-5-mini", { inputTokens: 10_000_000, outputTokens: 2_000_000 });
    expect(cost).toBeCloseTo(10 * 0.25 + 2 * 2.0, 10);
  });

  it("normalises a dated model snapshot to its base entry", () => {
    // OpenAI resolves an alias to a dated snapshot (see evals/record.ts's
    // comment on this exact behaviour) — the lookup must still find the price.
    const dated = estimateCostUsd("gpt-5-mini-2025-08-07", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(dated).toBeCloseTo(0.25, 10);
  });

  describe("prompt-cache fields", () => {
    it("prices a cache read at 0.1x the base input rate", () => {
      const withCache = estimateCostUsd("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
      });
      expect(withCache).toBeCloseTo(2 * 0.1, 10);
    });

    it("prices a cache write at 1.25x the base input rate", () => {
      const withCache = estimateCostUsd("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
      });
      expect(withCache).toBeCloseTo(2 * 1.25, 10);
    });

    it("sums fresh input, cache read, cache write, and output independently", () => {
      const cost = estimateCostUsd("claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(2 + 10 + 2 * 0.1 + 2 * 1.25, 10);
    });

    it("treats absent cache fields as zero cost, not fabricated usage", () => {
      // No cacheReadInputTokens/cacheCreationInputTokens at all — must cost
      // exactly the same as a usage object that never mentions caching.
      const withoutFields = estimateCostUsd("claude-sonnet-5", { inputTokens: 100, outputTokens: 50 });
      const withUndefinedFields = estimateCostUsd("claude-sonnet-5", {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: undefined,
        cacheCreationInputTokens: undefined,
      });
      expect(withUndefinedFields).toBe(withoutFields);
    });

    it("returns undefined for an unknown model even with cache fields present", () => {
      expect(
        estimateCostUsd("some-model-nobody-priced", {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
        })
      ).toBeUndefined();
    });
  });
});
