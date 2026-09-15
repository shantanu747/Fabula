"use client";

import { createContext, useContext, useReducer, useRef, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { ProviderSummary } from "@/lib/providers/list";
import type { GenerationErrorKind, SaveState, StoryState } from "./types";
import { streamGeneration } from "./streamGeneration";
import { DEFAULT_TARGET_LENGTH } from "./constants";
import { backoffDelayMs, NETWORK_RETRY_POLICY } from "./retry";
import { createStoryCreationCoordinator, persistParagraphs } from "./persistence";

// Re-exported so existing client call sites keep importing these from the context;
// they live in ./constants so the API routes can enforce the same bounds (see there).
export { DEFAULT_TARGET_LENGTH, MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from "./constants";

type Action =
  | { type: "SET_THEME"; value: string }
  | { type: "SET_CHARACTERS"; value: string }
  | { type: "SET_OPENING_LINES"; value: string }
  | { type: "SET_PROVIDER"; id: string }
  | { type: "SET_TARGET_LENGTH"; value: number }
  | { type: "SET_SHARED"; value: boolean }
  | { type: "SET_SHARE_ERROR"; value: boolean }
  | { type: "GENERATION_START" }
  | { type: "GENERATION_CHUNK"; text: string }
  | { type: "GENERATION_DONE"; paragraph: StoryParagraph; invented?: InventedMetadata }
  | {
      type: "GENERATION_ERROR";
      message: string;
      errorKind: GenerationErrorKind;
      failedProviderId?: string;
      suggestedProviderId?: string;
      suggestedProviderName?: string;
      retryAfterMs?: number;
    }
  | { type: "WRITER_SUBMIT"; text: string }
  | { type: "RESET"; defaultProviderId: string }
  | { type: "SET_STORY_ID"; id: string }
  | { type: "SET_SAVE_STATE"; value: SaveState }
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
    isShared: false,
    saveState: "unsaved",
    shareError: false,
  };
}

// Exported for StoryContext.test.ts — a pure reducer is the one part of this
// file testable without a jsdom/React-testing-library dependency (see the
// coverage exclusion below and docs/adr/0039).
export function storyReducer(state: StoryState, action: Action): StoryState {
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
    case "SET_SHARED":
      return { ...state, isShared: action.value };
    case "SET_SHARE_ERROR":
      return { ...state, shareError: action.value };
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
      return {
        ...state,
        generation: {
          kind: "error",
          message: action.message,
          errorKind: action.errorKind,
          failedProviderId: action.failedProviderId,
          suggestedProviderId: action.suggestedProviderId,
          suggestedProviderName: action.suggestedProviderName,
          retryAfterMs: action.retryAfterMs,
        },
      };
    case "WRITER_SUBMIT":
      if (!action.text) return state;
      return { ...state, paragraphs: [...state.paragraphs, { author: "writer", text: action.text }] };
    case "RESET":
      return initialState(action.defaultProviderId);
    case "SET_STORY_ID":
      return { ...state, storyId: action.id };
    case "SET_SAVE_STATE":
      return { ...state, saveState: action.value };
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
  /** Optimistically flips `isShared` and PATCHes it to the server; reverts on
   *  failure. A no-op until `storyId` exists — nothing to share server-side
   *  before the story is first persisted. */
  setShared: (value: boolean) => void;
  submitWriterParagraph: (text: string) => void;
  generateNext: () => void;
  /** Submits `text` as the Writer's paragraph, then immediately generates the
   *  AI's reply — as one action, not two separate clicks. Passes the updated
   *  paragraph list straight into generation instead of relying on `state`,
   *  which wouldn't yet reflect the WRITER_SUBMIT dispatch on this same tick. */
  submitAndContinue: (text: string) => void;
  /** Switches the AI provider for the rest of the session and immediately
   *  regenerates the current turn with it — the "Use {provider}" action on a
   *  provider-unavailable error banner (docs/adr/0023). Never rewrites a
   *  saved story's default provider; only story_paragraph.providerId (set via
   *  GENERATION_DONE) records who actually wrote a given paragraph. */
  switchProviderAndRetry: (providerId: string) => void;
  /** Re-attempts whatever last failed — story creation, a paragraph sync, or
   *  both — when `saveState` is "error". Reuses the same idempotency key
   *  (nothing new was "created" by the failure) and re-syncs the full current
   *  paragraph list, which is always safe to repeat (docs/adr/0013/0016). A
   *  no-op for a guest, who has nothing server-side to retry. */
  retrySave: () => void;
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
  // Owns both races a bare fetch can't (docs/adr/0044-durable-writer-turns-and-
  // idempotent-creation.md) — one per StoryProvider instance, i.e. one per
  // "logical story creation" until resetStory/hydrateStory calls .reset().
  // Cheap to construct (no I/O at creation time), so re-evaluating the
  // initializer on every render and keeping only the first is fine — same
  // tradeoff useRef(null) already makes for abortRef above.
  const storyCreationCoordinatorRef = useRef(createStoryCreationCoordinator());
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
  //
  // Failure is no longer silent (docs/adr/0044-durable-writer-turns-and-
  // idempotent-creation.md): saveState flips to "error" so the Writer can see
  // and retry it, instead of generation quietly proceeding unsaved with no
  // indication whatsoever. The coordinator itself — not a bare fetch — is what
  // makes the underlying request itself safe to retry: an in-flight ref for a
  // concurrent local caller, an Idempotency-Key for a network-level retry.
  async function ensureStoryId(): Promise<string | undefined> {
    if (!session?.user) return undefined;
    if (state.storyId) return state.storyId;

    dispatch({ type: "SET_SAVE_STATE", value: "saving" });
    const id = await storyCreationCoordinatorRef.current.ensureStoryId({
      theme: state.theme || undefined,
      characters: state.characters || undefined,
      openingLines: state.openingLines || undefined,
      targetLength: state.targetLength,
      selectedProviderId: state.selectedProviderId,
    });
    if (id) {
      dispatch({ type: "SET_STORY_ID", id });
    } else {
      dispatch({ type: "SET_SAVE_STATE", value: "error" });
    }
    return id;
  }

  // Mirrors a Writer's own paragraph the instant WRITER_SUBMIT fires — the
  // data-loss bug this plan exists to close (see the ADR above). `storyId`
  // undefined here means ensureStoryId itself already failed and dispatched
  // "error"; nothing further to do. A guest never reaches this at all (both
  // call sites below gate on `session?.user` first).
  async function persistWriterTurn(storyId: string | undefined, updatedParagraphs: StoryParagraph[]) {
    if (!storyId) return;
    const ok = await persistParagraphs(storyId, updatedParagraphs);
    dispatch({ type: "SET_SAVE_STATE", value: ok ? "saved" : "error" });
  }

  function runGeneration(
    retryCount: number,
    storySoFarOverride?: StoryParagraph[],
    storyId?: string,
    providerIdOverride?: string,
    networkRetryAttempt = 0
  ) {
    if (retryCount === 0 && state.generation.kind === "streaming") return;

    // The stale-closure trap (docs/adr/0008, docs/adr/0023): reading
    // state.selectedProviderId directly here would send the *old* provider
    // when this is called immediately after dispatching SET_PROVIDER on the
    // same tick (switchProviderAndRetry below) — the dispatch hasn't
    // re-rendered yet, so the closure's `state` is still the previous one.
    const providerId = providerIdOverride ?? state.selectedProviderId;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    dispatch({ type: "GENERATION_START" });

    void streamGeneration(
      {
        providerId,
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
        onDone: (text, metadata, persisted) => {
          dispatch({
            type: "GENERATION_DONE",
            paragraph: { author: "ai", text, providerId },
            invented: metadata,
          });
          // `persisted` is meaningful only when this turn actually sent a
          // storyId — for a guest, or a Writer whose story isn't saved yet,
          // the server never attempted a mirror write at all, and `persisted`
          // is `false` for that reason alone (streamGeneration.ts's own doc
          // comment on this). Gated on the local `storyId` param, not
          // state.storyId, for the same stale-closure reason `providerId` is
          // above: this closure's `state` predates whatever SET_STORY_ID may
          // have already dispatched earlier in this same logical turn.
          if (storyId !== undefined) {
            dispatch({ type: "SET_SAVE_STATE", value: persisted ? "saved" : "error" });
          }
        },
        onError: (error) => {
          // Auto-retry once, silently, on a mid-stream drop — only surface the
          // error banner if the retry attempt also fails. Rule 3 (docs/adr/0023):
          // never offered as a provider switch, so this always retries the same
          // providerId, never state.selectedProviderId.
          if (error.kind === "stream-aborted" && retryCount === 0) {
            runGeneration(1, storySoFarOverride, storyId, providerId, networkRetryAttempt);
            return;
          }
          // A short, bounded, silently-backed-off retry — distinct from
          // ADR 0023's rejection of backoff for a *provider* that's slow or
          // down (a human watching a screen, where a longer wait before
          // learning it failed is worse). This is our own fetch to
          // /api/generate never reaching the server at all — a dropped wifi
          // handoff, a backgrounded tab — worth a few quiet attempts before
          // asking the Writer to notice and act (see retry.ts's doc comment).
          if (error.kind === "network" && networkRetryAttempt < NETWORK_RETRY_POLICY.maxAttempts - 1) {
            const delayMs = backoffDelayMs(networkRetryAttempt, NETWORK_RETRY_POLICY);
            setTimeout(() => {
              runGeneration(retryCount, storySoFarOverride, storyId, providerId, networkRetryAttempt + 1);
            }, delayMs);
            return;
          }
          dispatch({
            type: "GENERATION_ERROR",
            message: error.message,
            errorKind: error.kind,
            failedProviderId: error.failedProviderId,
            suggestedProviderId: error.suggestedProviderId,
            suggestedProviderName: error.suggestedProviderName,
            retryAfterMs: error.retryAfterMs,
          });
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
    setShared: (value) => {
      if (!state.storyId) return;
      const storyId = state.storyId;
      const previous = state.isShared;
      dispatch({ type: "SET_SHARED", value });
      // Cleared on every new attempt, not just a successful one — a Writer
      // retrying after a failure shouldn't still see the old error banner
      // hanging around once this attempt's own outcome is known.
      dispatch({ type: "SET_SHARE_ERROR", value: false });
      void fetch(`/api/stories/${storyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isShared: value }),
      })
        .then((response) => {
          if (!response.ok) {
            dispatch({ type: "SET_SHARED", value: previous });
            dispatch({ type: "SET_SHARE_ERROR", value: true });
          }
        })
        .catch(() => {
          dispatch({ type: "SET_SHARED", value: previous });
          dispatch({ type: "SET_SHARE_ERROR", value: true });
        });
    },
    submitWriterParagraph: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const updated: StoryParagraph[] = [...state.paragraphs, { author: "writer", text: trimmed }];
      dispatch({ type: "WRITER_SUBMIT", text: trimmed });
      if (session?.user) {
        dispatch({ type: "SET_SAVE_STATE", value: "saving" });
        void ensureStoryId().then((storyId) => persistWriterTurn(storyId, updated));
      }
    },
    generateNext: () => {
      void ensureStoryId().then((storyId) => runGeneration(0, undefined, storyId));
    },
    submitAndContinue: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const updated: StoryParagraph[] = [...state.paragraphs, { author: "writer", text: trimmed }];
      dispatch({ type: "WRITER_SUBMIT", text: trimmed });
      const isWriter = Boolean(session?.user);
      if (isWriter) dispatch({ type: "SET_SAVE_STATE", value: "saving" });
      void ensureStoryId().then((storyId) => {
        // Concurrent, not sequential: persisting the Writer's own paragraph
        // must not delay the AI starting to write (the Gotcha this plan
        // names explicitly). Safe to race against /api/generate's own
        // diff-based sync of the same paragraph — syncStoryParagraphs'
        // UNIQUE(storyId, position) constraint is exactly what already makes
        // two concurrent writers of the same content safe (ADRs 0013/0016).
        runGeneration(0, updated, storyId);
        if (isWriter) void persistWriterTurn(storyId, updated);
      });
    },
    switchProviderAndRetry: (providerId) => {
      // Same stale-closure hazard as submitAndContinue (docs/adr/0008): pass
      // providerId straight into runGeneration rather than dispatching
      // SET_PROVIDER and reading state.selectedProviderId back, since the
      // dispatch hasn't re-rendered (and refreshed the closure) yet.
      dispatch({ type: "SET_PROVIDER", id: providerId });
      void ensureStoryId().then((storyId) => runGeneration(0, undefined, storyId, providerId));
    },
    retrySave: () => {
      if (!session?.user) return;
      dispatch({ type: "SET_SAVE_STATE", value: "saving" });
      void ensureStoryId().then((id) => persistWriterTurn(id, state.paragraphs));
    },
    resetStory: () => {
      abortRef.current?.abort();
      abortRef.current = null;
      // A new story is a new "logical creation" — reusing the old
      // idempotency key here would make this story collide with whatever the
      // previous one's key already claimed (or, if that attempt never
      // finished, replay into it instead of starting fresh).
      storyCreationCoordinatorRef.current.reset();
      dispatch({ type: "RESET", defaultProviderId: providers[0]?.id ?? "" });
    },
    hydrateStory: (nextState) => {
      abortRef.current?.abort();
      abortRef.current = null;
      storyCreationCoordinatorRef.current.reset();
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
