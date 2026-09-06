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
});
