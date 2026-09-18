import { describe, expect, it } from "vitest";
import { countOutcomes, successfulTtftMs } from "./slo-report.mts";
import type { RecentGenerationOutcome } from "../src/lib/db/generationEvents";

function row(outcome: RecentGenerationOutcome["outcome"], ttftMs: number | null = null): RecentGenerationOutcome {
  return { outcome, ttftMs };
}

describe("countOutcomes", () => {
  it("tallies each outcome bucket independently", () => {
    const rows = [row("success"), row("success"), row("persist_failed"), row("provider_error"), row("cancelled")];

    expect(countOutcomes(rows)).toEqual({ success: 2, persistFailed: 1, providerError: 1, cancelled: 1 });
  });

  it("returns all zeros for an empty window", () => {
    expect(countOutcomes([])).toEqual({ success: 0, persistFailed: 0, providerError: 0, cancelled: 0 });
  });
});

describe("successfulTtftMs", () => {
  it("includes success and persist_failed rows with a ttftMs, in order", () => {
    const rows = [row("success", 100), row("persist_failed", 200), row("provider_error", 300)];

    expect(successfulTtftMs(rows)).toEqual([100, 200]);
  });

  it("excludes a success/persist_failed row with a null ttftMs (never reached first chunk)", () => {
    const rows = [row("success", null), row("success", 150)];

    expect(successfulTtftMs(rows)).toEqual([150]);
  });

  it("returns an empty array for an empty window", () => {
    expect(successfulTtftMs([])).toEqual([]);
  });
});
