import { describe, expect, it } from "vitest";
import { isAIsTurn, isWritersTurn } from "./turn";

describe("turn functions", () => {
  it("isAIsTurn returns true for empty array", () => {
    expect(isAIsTurn([])).toBe(true);
  });

  it("isAIsTurn returns true when last paragraph is not AI", () => {
    expect(isAIsTurn([{ author: "writer", text: "test" }])).toBe(true);
  });

  it("isAIsTurn returns false when last paragraph is AI", () => {
    expect(isAIsTurn([{ author: "ai", text: "test" }])).toBe(false);
  });

  it("isWritersTurn returns true for empty array", () => {
    expect(isWritersTurn([])).toBe(true);
  });

  it("isWritersTurn returns true when last paragraph is not writer", () => {
    expect(isWritersTurn([{ author: "ai", text: "test" }])).toBe(true);
  });

  it("isWritersTurn returns false when last paragraph is writer", () => {
    expect(isWritersTurn([{ author: "writer", text: "test" }])).toBe(false);
  });
});