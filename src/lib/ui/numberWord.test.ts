import { describe, expect, it } from "vitest";
import { numberWord } from "./numberWord";

describe("numberWord", () => {
  it("spells out a number in the covered range", () => {
    expect(numberWord(12)).toBe("twelve");
  });

  it("spells out zero", () => {
    expect(numberWord(0)).toBe("zero");
  });

  it("spells out the top of the covered range", () => {
    expect(numberWord(30)).toBe("thirty");
  });

  it("falls back to digits past the covered range", () => {
    expect(numberWord(31)).toBe("31");
  });

  it("capitalizes the first letter when asked", () => {
    expect(numberWord(11, { capitalize: true })).toBe("Eleven");
  });

  it("does not capitalize by default", () => {
    expect(numberWord(11)).toBe("eleven");
  });

  it("capitalizes a digit fallback as itself, since it has no letter case", () => {
    expect(numberWord(42, { capitalize: true })).toBe("42");
  });
});
