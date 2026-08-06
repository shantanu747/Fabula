"use client";

import { createContext, useContext, useReducer, useRef, type ReactNode } from "react";
import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { ProviderSummary } from "@/lib/providers/list";
import type { GenerationErrorKind, StoryState } from "./types";
import { streamGeneration } from "./streamGeneration";

type Action =
  | { type: "SET_THEME"; value: string }
  | { type: "SET_CHARACTERS"; value: string }
  | { type: "SET_OPENING_LINES"; value: string }
  | { type: "SET_PROVIDER"; id: string }
  | { type: "GENERATION_START" }
  | { type: "GENERATION_CHUNK"; text: string }
  | { type: "GENERATION_DONE"; paragraph: StoryParagraph; invented?: InventedMetadata }
  | { type: "GENERATION_ERROR"; message: string; errorKind: GenerationErrorKind }
  | { type: "WRITER_SUBMIT"; text: string }
  | { type: "RESET"; defaultProviderId: string };

function initialState(defaultProviderId: string): StoryState {
  return {
    theme: "",
    characters: "",
    openingLines: "",
    selectedProviderId: defaultProviderId,
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
  submitWriterParagraph: (text: string) => void;
  generateNext: () => void;
  resetStory: () => void;
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

  // Plain functions (not useCallback) so each closes over this render's state —
  // avoids stale-closure bugs from an incomplete dependency array. Acceptable
  // tradeoff at this app's scale (one story, a handful of paragraphs).
  function runGeneration(retryCount: number) {
    if (retryCount === 0 && state.generation.kind === "streaming") return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    dispatch({ type: "GENERATION_START" });

    void streamGeneration(
      {
        providerId: state.selectedProviderId,
        storySoFar: state.paragraphs,
        theme: state.theme || undefined,
        characters: state.characters || undefined,
        openingLines: state.openingLines || undefined,
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
            runGeneration(1);
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
    submitWriterParagraph: (text) => dispatch({ type: "WRITER_SUBMIT", text: text.trim() }),
    generateNext: () => runGeneration(0),
    resetStory: () => {
      abortRef.current?.abort();
      abortRef.current = null;
      dispatch({ type: "RESET", defaultProviderId: providers[0]?.id ?? "" });
    },
  };

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}

export function useStory(): StoryContextValue {
  const ctx = useContext(StoryContext);
  if (!ctx) throw new Error("useStory must be used within a StoryProvider");
  return ctx;
}
