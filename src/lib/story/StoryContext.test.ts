import { describe, expect, it } from "vitest";
import { storyReducer } from "./StoryContext";
import type { StoryState } from "./types";

function baseState(overrides: Partial<StoryState> = {}): StoryState {
  return {
    theme: "",
    characters: "",
    openingLines: "",
    selectedProviderId: "anthropic",
    targetLength: 12,
    paragraphs: [],
    invented: undefined,
    generation: { kind: "idle" },
    isShared: false,
    ...overrides,
  };
}

describe("storyReducer SET_SHARED", () => {
  it("sets isShared to true", () => {
    const state = baseState({ storyId: "story-1", isShared: false });
    const next = storyReducer(state, { type: "SET_SHARED", value: true });
    expect(next.isShared).toBe(true);
  });

  it("sets isShared to false", () => {
    const state = baseState({ storyId: "story-1", isShared: true });
    const next = storyReducer(state, { type: "SET_SHARED", value: false });
    expect(next.isShared).toBe(false);
  });

  it("does not mutate other state fields", () => {
    const state = baseState({ storyId: "story-1", theme: "A quiet mystery" });
    const next = storyReducer(state, { type: "SET_SHARED", value: true });
    expect(next).toEqual({ ...state, isShared: true });
  });
});
