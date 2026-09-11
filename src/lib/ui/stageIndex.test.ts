import { describe, expect, it } from "vitest";
import { stageIndex } from "./stageIndex";

describe("stageIndex", () => {
  it("returns 0 (Setup) below the 25% boundary", () => {
    expect(stageIndex(0)).toBe(0);
    expect(stageIndex(0.24)).toBe(0);
  });

  it("returns 1 (Turn) at and above the 25% boundary, below 55%", () => {
    expect(stageIndex(0.25)).toBe(1);
    expect(stageIndex(0.54)).toBe(1);
  });

  it("returns 2 (Climax) at and above the 55% boundary, below 85%", () => {
    expect(stageIndex(0.55)).toBe(2);
    expect(stageIndex(0.84)).toBe(2);
  });

  it("returns 3 (Close) at and above the 85% boundary", () => {
    expect(stageIndex(0.85)).toBe(3);
    expect(stageIndex(1)).toBe(3);
  });
});
