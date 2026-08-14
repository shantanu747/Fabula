import { describe, expect, it } from "vitest";
import { MAX_HINT_LENGTH, MAX_OPENING_LINES_LENGTH, MAX_TARGET_LENGTH, MIN_TARGET_LENGTH } from "./constants";
import {
  areValidHints,
  isStoryParagraph,
  isStoryParagraphArray,
  isValidHint,
  isValidTargetLength,
} from "./validation";

describe("isStoryParagraph", () => {
  it("accepts a well-formed writer paragraph", () => {
    expect(isStoryParagraph({ author: "writer", text: "Once upon a time." })).toBe(true);
  });

  it("accepts a well-formed AI paragraph with a providerId", () => {
    expect(isStoryParagraph({ author: "ai", text: "...", providerId: "anthropic" })).toBe(true);
  });

  it("rejects a bad author value", () => {
    expect(isStoryParagraph({ author: "narrator", text: "..." })).toBe(false);
  });

  it("rejects a non-string text field", () => {
    expect(isStoryParagraph({ author: "writer", text: 123 })).toBe(false);
  });

  it("rejects a non-string providerId when present", () => {
    expect(isStoryParagraph({ author: "ai", text: "...", providerId: 1 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isStoryParagraph(null)).toBe(false);
    expect(isStoryParagraph("paragraph")).toBe(false);
    expect(isStoryParagraph(undefined)).toBe(false);
  });
});

describe("isStoryParagraphArray", () => {
  it("accepts an empty array", () => {
    expect(isStoryParagraphArray([])).toBe(true);
  });

  it("rejects an array containing one malformed element", () => {
    expect(
      isStoryParagraphArray([{ author: "writer", text: "ok" }, { author: "writer" }])
    ).toBe(false);
  });

  it("rejects non-arrays", () => {
    expect(isStoryParagraphArray({ length: 0 })).toBe(false);
  });
});

describe("isValidTargetLength", () => {
  it("accepts the documented bounds", () => {
    expect(isValidTargetLength(MIN_TARGET_LENGTH)).toBe(true);
    expect(isValidTargetLength(MAX_TARGET_LENGTH)).toBe(true);
  });

  it("rejects values outside the bounds", () => {
    expect(isValidTargetLength(MIN_TARGET_LENGTH - 1)).toBe(false);
    expect(isValidTargetLength(MAX_TARGET_LENGTH + 1)).toBe(false);
  });

  it("rejects non-integers and non-numbers", () => {
    expect(isValidTargetLength(10.5)).toBe(false);
    expect(isValidTargetLength("14")).toBe(false);
    expect(isValidTargetLength(undefined)).toBe(false);
  });
});

describe("isValidHint", () => {
  it("accepts undefined (the hint is optional)", () => {
    expect(isValidHint(undefined)).toBe(true);
  });

  it("accepts a string within the default max", () => {
    expect(isValidHint("a".repeat(MAX_HINT_LENGTH))).toBe(true);
  });

  it("rejects a string past the default max", () => {
    expect(isValidHint("a".repeat(MAX_HINT_LENGTH + 1))).toBe(false);
  });

  it("respects a custom max", () => {
    expect(isValidHint("a".repeat(50), 50)).toBe(true);
    expect(isValidHint("a".repeat(51), 50)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidHint(123)).toBe(false);
    expect(isValidHint(null)).toBe(false);
  });
});

describe("areValidHints", () => {
  it("accepts a body with all hints omitted", () => {
    expect(areValidHints({})).toBe(true);
  });

  it("accepts a body with all hints within bounds", () => {
    expect(
      areValidHints({
        theme: "a fairy tale",
        characters: "a fox and a crow",
        openingLines: "a".repeat(MAX_OPENING_LINES_LENGTH),
      })
    ).toBe(true);
  });

  it("rejects when openingLines exceeds its own (larger) cap", () => {
    expect(areValidHints({ openingLines: "a".repeat(MAX_OPENING_LINES_LENGTH + 1) })).toBe(false);
  });

  it("rejects when theme exceeds the generic hint cap", () => {
    expect(areValidHints({ theme: "a".repeat(MAX_HINT_LENGTH + 1) })).toBe(false);
  });
});
