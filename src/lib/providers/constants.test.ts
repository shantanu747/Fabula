import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_CHAR_BUDGET,
  FIRST_CHUNK_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  STREAM_IDLE_TIMEOUT_MS,
} from "./constants";

// This tier is held at 100% coverage (vitest.config.mts), so every constant
// needs at least one line exercising it directly rather than relying on some
// other suite's incidental import.
describe("provider constants", () => {
  it("exposes the generation budgets other modules depend on", () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
    expect(CONTEXT_WINDOW_CHAR_BUDGET).toBeGreaterThan(0);
  });

  it("bounds the pre-first-chunk wait and the mid-stream idle gap", () => {
    expect(FIRST_CHUNK_TIMEOUT_MS).toBe(20_000);
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(30_000);
    // The idle budget is generous relative to the startup budget — a stream
    // already producing tokens is trusted longer than one that hasn't started.
    expect(STREAM_IDLE_TIMEOUT_MS).toBeGreaterThan(FIRST_CHUNK_TIMEOUT_MS);
  });
});
