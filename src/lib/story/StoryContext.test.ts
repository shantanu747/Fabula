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
    saveState: "unsaved",
    shareError: false,
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

describe("storyReducer SET_SHARE_ERROR", () => {
  it("sets shareError", () => {
    const state = baseState({ shareError: false });
    const next = storyReducer(state, { type: "SET_SHARE_ERROR", value: true });
    expect(next.shareError).toBe(true);
  });

  it("clears shareError", () => {
    const state = baseState({ shareError: true });
    const next = storyReducer(state, { type: "SET_SHARE_ERROR", value: false });
    expect(next.shareError).toBe(false);
  });
});

describe("storyReducer SET_SAVE_STATE", () => {
  it.each(["saved", "saving", "unsaved", "error"] as const)("transitions to %s", (value) => {
    const state = baseState({ saveState: "unsaved" });
    const next = storyReducer(state, { type: "SET_SAVE_STATE", value });
    expect(next.saveState).toBe(value);
  });

  it("does not mutate other state fields", () => {
    const state = baseState({ paragraphs: [{ author: "writer", text: "hello" }] });
    const next = storyReducer(state, { type: "SET_SAVE_STATE", value: "saving" });
    expect(next).toEqual({ ...state, saveState: "saving" });
  });
});

describe("storyReducer GENERATION_ERROR", () => {
  it("carries retryAfterMs through into the error state", () => {
    const state = baseState();
    const next = storyReducer(state, {
      type: "GENERATION_ERROR",
      message: "Too many requests",
      errorKind: "rate-limited",
      retryAfterMs: 5000,
    });
    expect(next.generation).toEqual({
      kind: "error",
      message: "Too many requests",
      errorKind: "rate-limited",
      failedProviderId: undefined,
      suggestedProviderId: undefined,
      suggestedProviderName: undefined,
      retryAfterMs: 5000,
    });
  });

  it("leaves retryAfterMs undefined for an error kind that never carries one", () => {
    const state = baseState();
    const next = storyReducer(state, {
      type: "GENERATION_ERROR",
      message: "It's the Writer's turn.",
      errorKind: "turn-violation",
    });
    expect(next.generation).toMatchObject({ retryAfterMs: undefined });
  });
});

describe("storyReducer SET_STORY_ID", () => {
  it("sets storyId without touching saveState", () => {
    const state = baseState({ saveState: "saving" });
    const next = storyReducer(state, { type: "SET_STORY_ID", id: "story-1" });
    expect(next).toEqual({ ...state, storyId: "story-1" });
  });
});
