import { describe, expect, it } from "vitest";
import { longestSentinelPrefixOverlap } from "./src/lib/story/streamGeneration";

describe("longestSentinelPrefixOverlap", () => {
  it("returns 0 for no overlap", () => {
    expect(longestSentinelPrefixOverlap("hello world")).toBe(0);
  });

  it("returns correct overlap length", () => {
    // SENTINEL is "\n FABULA:METADATA " (18 chars), so max overlap from SENTINEL.length - 1 is 17
    // Looking for: "test\n FABULA:METADATA" ending with first 17 chars of sentinel: "\n FABULA:METADATA"
    expect(longestSentinelPrefixOverlap("test\n FABULA:METADATA")).toBe(17);
  });

  it("handles partial sentinel at end", () => {
    // Looking for how much of the sentinel prefix matches the end of "prefix\n FABULA"
    expect(longestSentinelPrefixOverlap("prefix\n FABULA")).toBe(8); // Length of "\n FABULA"
  });
});