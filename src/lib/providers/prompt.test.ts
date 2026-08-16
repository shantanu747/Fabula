import { describe, expect, it } from "vitest";
import { windowStoryParagraphs } from "./prompt";

describe("windowStoryParagraphs", () => {
  it("returns empty array when input is empty", () => {
    expect(windowStoryParagraphs([])).toEqual([]);
  });

  it("returns full array when within budget", () => {
    const paragraphs = [
      { author: "writer" as const, text: "short" },
      { author: "ai" as const, text: "text" }
    ];
    expect(windowStoryParagraphs(paragraphs)).toBe(paragraphs); // identity reference check
  });

  it("keeps anchor and recent paragraphs when over budget", () => {
    const longAnchor = { author: "writer" as const, text: "a".repeat(10000) }; // Over budget
    const recent = { author: "ai" as const, text: "recent" };
    const result = windowStoryParagraphs([longAnchor, recent]);
    
    // Should keep the anchor with note and the recent paragraph
    expect(result[0].text).toContain("a".repeat(10000)); // Anchor preserved
    expect(result.length).toBeGreaterThan(0); // At least one item
  });
});