import { describe, expect, it } from "vitest";
import { checkStructural } from "./structural";

/** Prose of exactly `n` words: "w1 w2 … wN". */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
}

const plain60 = words(60);
const plain220 = words(220);

describe("checkStructural", () => {
  it("passes a plain in-range paragraph", () => {
    const result = checkStructural(plain60 + " and a little more prose for good measure.", {
      expectMetadataHeader: false,
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("accepts exactly 60 words (lower bound inclusive)", () => {
    expect(checkStructural(plain60, { expectMetadataHeader: false }).passed).toBe(true);
  });

  it("rejects 59 words", () => {
    const result = checkStructural(words(59), { expectMetadataHeader: false });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("59"))).toBe(true);
  });

  it("accepts exactly 220 words (upper bound inclusive)", () => {
    expect(checkStructural(plain220, { expectMetadataHeader: false }).passed).toBe(true);
  });

  it("rejects 221 words", () => {
    const result = checkStructural(words(221), { expectMetadataHeader: false });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("221"))).toBe(true);
  });

  it("allows a single newline inside a paragraph", () => {
    const withBreak = plain60 + "\n" + words(10);
    expect(checkStructural(withBreak, { expectMetadataHeader: false }).passed).toBe(true);
  });

  it("rejects a blank-line break (two paragraphs)", () => {
    const two = plain60 + "\n\n" + words(10);
    const result = checkStructural(two, { expectMetadataHeader: false });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("blank-line"))).toBe(true);
  });

  it("rejects a leading author label", () => {
    const result = checkStructural("AI: " + plain60, { expectMetadataHeader: false });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("author label"))).toBe(true);
  });

  it("rejects a quote wrapper", () => {
    const result = checkStructural('"' + plain60 + '"', { expectMetadataHeader: false });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("quotation"))).toBe(true);
  });

  it("rejects a markdown heading", () => {
    const result = checkStructural("## Chapter One\n" + plain60, { expectMetadataHeader: false });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("heading"))).toBe(true);
  });

  it("rejects leaked THEME: scaffolding", () => {
    const result = checkStructural(plain60 + " more", {
      expectMetadataHeader: false,
    });
    expect(
      checkStructural("THEME: a mystery\n" + plain60, { expectMetadataHeader: false }).failures.some(
        (f) => f.includes("scaffolding")
      )
    ).toBe(true);
    expect(result.passed).toBe(true); // control: the same prose without scaffolding passes
  });

  it("rejects a standalone --- delimiter line", () => {
    const result = checkStructural(plain60 + "\n---", { expectMetadataHeader: false });
    expect(result.failures.some((f) => f.includes("scaffolding"))).toBe(true);
  });

  it("requires parsed metadata only when the header was expected", () => {
    expect(checkStructural(plain60, { expectMetadataHeader: true, metadata: undefined }).passed).toBe(
      false
    );
    expect(
      checkStructural(plain60, {
        expectMetadataHeader: true,
        metadata: { theme: "mystery", characters: "Mara" },
      }).passed
    ).toBe(true);
    expect(checkStructural(plain60, { expectMetadataHeader: false, metadata: undefined }).passed).toBe(
      true
    );
  });

  it("rejects metadata with an empty theme even when characters parsed", () => {
    const result = checkStructural(plain60, {
      expectMetadataHeader: true,
      metadata: { theme: "", characters: "Mara" },
    });
    expect(result.passed).toBe(false);
  });
});
