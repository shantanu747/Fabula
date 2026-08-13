"use client";

import { createContext, useContext, useReducer, useRef, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { ProviderSummary } from "@/lib/providers/list";
import type { GenerationErrorKind, StoryState } from "./types";
import { streamGeneration } from "./streamGeneration";
import { DEFAULT_TARGET_LENGTH } from "./constants";

// Re-exported so existing client call sites keep importing these from the context;
// they live in ./constants so the API routes can enforce the same bounds (see there).
export { DEFAULT_TARGET_LENGTH, MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from "./constants";

type Action =
  | { type: "SET_THEME"; value: string }
  | { type: "SET_CHARACTERS"; value: string }
  | { type: "SET_OPENING_LINES"; value: string }
  | { type: "SET_PROVIDER"; id: string }
  | { type: "SET_TARGET_LENGTH"; value: number }
  | { type: "GENERATION_START" }
  | { type: "GENERATION_CHUNK"; text: string }
  | { type: "GENERATION_DONE"; paragraph: StoryParagraph; invented?: InventedMetadata }
  | { type: "GENERATION_ERROR"; message: string; errorKind: GenerationErrorKind }
  | { type: "WRITER_SUBMIT"; text: string }
  | { type: "RESET"; defaultProviderId: string }
  | { type: "SET_STORY_ID"; id: string }
  | { type: "HYDRATE_STORY"; state: StoryState };

function initialState(defaultProviderId: string): StoryState {
  return {
    theme: "",
    characters: "",
    openingLines: "",
    selectedProviderId: defaultProviderId,
    targetLength: DEFAULT_TARGET_LENGTH,
    paragraphs: [],
    invented: undefined,
    generation: { kind: "idle" },
  };
}

function storyReducer(state: StoryState, action: Action): StoryState {
  switch (action.type) {
    case "SET_THEME":
      return { ...state, theme: action.value };
    case "SET_CHARACTERS":
      return { ...state, characters: action.value };
    case "SET_OPENING_LINES":
      return { ...state, openingLines: action.value };
    case "SET_PROVIDER":
      return { ...state, selectedProviderId: action.id };
    case "SET_TARGET_LENGTH":
      return { ...state, targetLength: action.value };
    case "GENERATION_START":
      return { ...state, generation: { kind: "streaming", text: "" } };
    case "GENERATION_CHUNK":
      return { ...state, generation: { kind: "streaming", text: action.text } };
    case "GENERATION_DONE":
      return {
        ...state,
        paragraphs: [...state.paragraphs, action.paragraph],
        invented: action.invented ?? state.invented,
        generation: { kind: "idle" },
      };
    case "GENERATION_ERROR":
      return { ...state, generation: { kind: "error", message: action.message, errorKind: action.errorKind } };
    case "WRITER_SUBMIT":
      if (!action.text) return state;
      return { ...state, paragraphs: [...state.paragraphs, { author: "writer", text: action.text }] };
    case "RESET":
      return initialState(action.defaultProviderId);
    case "SET_STORY_ID":
      return { ...state, storyId: action.id };
    case "HYDRATE_STORY":
      return action.state;
    default:
      return state;
  }
}

interface StoryContextValue extends StoryState {
  providers: ProviderSummary[];
  setTheme: (value: string) => void;
  setCharacters: (value: string) => void;
  setOpeningLines: (value: string) => void;
  setSelectedProviderId: (id: string) => void;
  setTargetLength: (value: number) => void;
  submitWriterParagraph: (text: string) => void;
  generateNext: () => void;
  /** Submits `text` as the Writer's paragraph, then immediately generates the
   *  AI's reply — as one action, not two separate clicks. Passes the updated
   *  paragraph list straight into generation instead of relying on `state`,
   *  which wouldn't yet reflect the WRITER_SUBMIT dispatch on this same tick. */
  submitAndContinue: (text: string) => void;
  resetStory: () => void;
  /** Replaces the entire story with a previously-saved one loaded from
   *  GET /api/stories/:id (see /library and /story?storyId=…). */
  hydrateStory: (state: StoryState) => void;
}

const StoryContext = createContext<StoryContextValue | null>(null);

export function StoryProvider({
  providers,
  children,
}: {
  providers: ProviderSummary[];
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(storyReducer, providers[0]?.id ?? "", initialState);
  const abortRef = useRef<AbortController | null>(null);
  const { data: session } = useSession();

  // Plain functions (not useCallback) so each closes over this render's state —
  // avoids stale-closure bugs from an incomplete dependency array. Acceptable
  // tradeoff at this app's scale (one story, a handful of paragraphs).

  // Lazily creates the server-side story row on a logged-in Writer's first turn.
  // Guests, and turns after the first, are no-ops/cache hits — no new persistence
  // is added to the per-turn request shape (see docs/adr/0009). Because this fires
  // on the *next* turn regardless of whether the Writer started as a guest, it also
  // doubles as guest-story adoption: sign in mid-story, keep writing, and the whole
  // paragraph backlog is persisted via /api/generate's diff-based sync.
  async function ensureStoryId(): Promise<string | undefined> {
    if (!session?.user) return undefined;
    if (state.storyId) return state.storyId;
    try {
      const response = await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme: state.theme || undefined,
          characters: state.characters || undefined,
          openingLines: state.openingLines || undefined,
          targetLength: state.targetLength,
          selectedProviderId: state.selectedProviderId,
        }),
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { id: string };
      dispatch({ type: "SET_STORY_ID", id: data.id });
      return data.id;
    } catch {
      return undefined; // best-effort — generation still proceeds unsaved
    }
  }

  function runGeneration(retryCount: number, storySoFarOverride?: StoryParagraph[], storyId?: string) {
    if (retryCount === 0 && state.generation.kind === "streaming") return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    dispatch({ type: "GENERATION_START" });

    void streamGeneration(
      {
        providerId: state.selectedProviderId,
        storySoFar: storySoFarOverride ?? state.paragraphs,
        theme: state.theme || undefined,
        characters: state.characters || undefined,
        openingLines: state.openingLines || undefined,
        targetLength: state.targetLength,
        storyId,
      },
      controller.signal,
      {
        onChunk: (text) => dispatch({ type: "GENERATION_CHUNK", text }),
        onDone: (text, metadata) =>
          dispatch({
            type: "GENERATION_DONE",
            paragraph: { author: "ai", text, providerId: state.selectedProviderId },
            invented: metadata,
          }),
        onError: (error) => {
          // Auto-retry once, silently, on a mid-stream drop — only surface the
          // error banner if the retry attempt also fails.
          if (error.kind === "stream-aborted" && retryCount === 0) {
            runGeneration(1, storySoFarOverride, storyId);
            return;
          }
          dispatch({ type: "GENERATION_ERROR", message: error.message, errorKind: error.kind });
        },
      }
    );
  }

  const value: StoryContextValue = {
    ...state,
    providers,
    setTheme: (value) => dispatch({ type: "SET_THEME", value }),
    setCharacters: (value) => dispatch({ type: "SET_CHARACTERS", value }),
    setOpeningLines: (value) => dispatch({ type: "SET_OPENING_LINES", value }),
    setSelectedProviderId: (id) => dispatch({ type: "SET_PROVIDER", id }),
    setTargetLength: (value) => dispatch({ type: "SET_TARGET_LENGTH", value }),
    submitWriterParagraph: (text) => dispatch({ type: "WRITER_SUBMIT", text: text.trim() }),
    generateNext: () => {
      void ensureStoryId().then((storyId) => runGeneration(0, undefined, storyId));
    },
    submitAndContinue: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const updated: StoryParagraph[] = [...state.paragraphs, { author: "writer", text: trimmed }];
      dispatch({ type: "WRITER_SUBMIT", text: trimmed });
      void ensureStoryId().then((storyId) => runGeneration(0, updated, storyId));
    },
    resetStory: () => {
      abortRef.current?.abort();
      abortRef.current = null;
      dispatch({ type: "RESET", defaultProviderId: providers[0]?.id ?? "" });
    },
    hydrateStory: (nextState) => {
      abortRef.current?.abort();
      abortRef.current = null;
      dispatch({ type: "HYDRATE_STORY", state: nextState });
    },
  };

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}

export function useStory(): StoryContextValue {
  const ctx = useContext(StoryContext);
  if (!ctx) throw new Error("useStory must be used within a StoryProvider");
  return ctx;
}
