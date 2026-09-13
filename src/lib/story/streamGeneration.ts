import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { GenerationErrorKind } from "./types";
import { SSEStreamParser, type DecodedFrame } from "@/lib/streaming/protocol";
import { parseRetryAfterMs } from "./retry";

export interface GenerateRequestBody {
  providerId: string;
  storySoFar: StoryParagraph[];
  theme?: string;
  characters?: string;
  openingLines?: string;
  targetLength?: number;
  /** Present only for logged-in Writers who've saved this story — see api/stories. */
  storyId?: string;
}

export interface GenerationError {
  kind: GenerationErrorKind;
  message: string;
  /** Only present for a "provider-unavailable" error (see route.ts's 502 body). */
  failedProviderId?: string;
  suggestedProviderId?: string;
  suggestedProviderName?: string;
  /** Only present for a "rate-limited" error whose response carried a
   *  parseable `Retry-After` (`src/lib/ratelimit/store.ts` always sends one;
   *  `undefined` here means the header was missing or malformed, never that
   *  the wait is zero). Milliseconds from now, not a raw header value —
   *  `retry.ts`'s `parseRetryAfterMs` already resolved both the delay-seconds
   *  and HTTP-date forms into one shape the UI can count down from directly. */
  retryAfterMs?: number;
}

export interface StreamCallbacks {
  onChunk: (textSoFar: string) => void;
  /** `persisted` mirrors the `done` frame's own field (docs/adr/0042) exactly
   *  as sent — `false` for a guest turn too (nothing was ever attempted for
   *  one), not just for a genuine mirror-write failure. The caller must gate
   *  on whether it sent a `storyId` for this turn before treating `false` as
   *  a save failure worth surfacing (docs/adr/0044-durable-writer-turns-and-
   *  idempotent-creation.md) — this module has no way to make that
   *  distinction itself, since a guest and a failed write are indistinguishable
   *  on the wire by design (the field only ever means "is the mirror caught up
   *  with this paragraph", which is trivially true — nothing to catch up —
   *  when there's no mirror at all). */
  onDone: (finalText: string, metadata: InventedMetadata | undefined, persisted: boolean) => void;
  onError: (error: GenerationError) => void;
}

interface StreamState {
  visibleText: string;
  lastEventId: number;
  metadata?: InventedMetadata;
}

type ConsumeResult =
  | { outcome: "done"; persisted: boolean }
  | { outcome: "error"; error: GenerationError }
  /** The reader threw for a reason that isn't our own signal firing — a real
   *  network/transport break. The caller decides what to do next (attempt
   *  resume, or surface the existing generic error). */
  | { outcome: "transport-failure" }
  /** `signal` was the thing that fired — a genuine local abort (switching
   *  providers, unmounting), not a failure of any kind. Nothing to report. */
  | { outcome: "aborted" };

/**
 * Drives one framed response (the initial POST, or a resume GET) to a
 * terminal frame, calling `onChunk` as prose arrives and mutating `state` in
 * place so a subsequent resume attempt continues from exactly where this
 * left off — same accumulated text, same last-seen event id.
 */
async function consumeFrames(
  response: Response,
  state: StreamState,
  onChunk: (textSoFar: string) => void,
  signal: AbortSignal
): Promise<ConsumeResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEStreamParser();

  function handle(frame: DecodedFrame): ConsumeResult | undefined {
    if (frame.id !== undefined) state.lastEventId = Math.max(state.lastEventId, frame.id);
    const event = frame.event;
    switch (event.event) {
      case "chunk":
        state.visibleText += event.data.text;
        onChunk(state.visibleText);
        return undefined;
      case "meta":
        state.metadata = event.data.invented;
        return undefined;
      case "usage":
        // Server-side cost accounting only (docs/adr/0022) — no current UI
        // surface consumes token usage, so this is parsed and discarded.
        return undefined;
      case "error":
        return {
          outcome: "error",
          error: {
            kind: event.data.kind,
            message: event.data.message,
            suggestedProviderId: event.data.suggestedProviderId,
            suggestedProviderName: event.data.suggestedProviderName,
          },
        };
      case "done":
        // `position`/`storyId` are parsed by the frame decoder but not
        // surfaced here — the caller already knows its own storyId, and
        // position has no client-side use. `persisted` is what Plan 5 needs
        // (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md).
        return { outcome: "done", persisted: event.data.persisted };
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const result = handle(frame);
          if (result) return result;
        }
      }
      if (done) break;
    }
    // The stream closed normally without ever reaching a done/error frame —
    // not expected from a well-behaved server, but handled the same way a
    // transport failure is rather than silently treating it as success.
    return { outcome: "transport-failure" };
  } catch {
    // See the fetch() catch block below for the same distinction and why it
    // matters: an AbortError here can mean *this call's own* controller fired
    // (a genuine local abort) or a browser-cancelled fetch that never touched
    // our signal at all (docs/adr/0026) — only the former is silent.
    if (signal.aborted) return { outcome: "aborted" };
    return { outcome: "transport-failure" };
  }
}

/**
 * Attempts to pick a dropped stream back up from `state.lastEventId`, once
 * (docs/adr/0043). A 404 (buffer expired, never existed, or Redis wasn't
 * configured in the first place) and a genuine transport failure on the
 * resume call itself both fall through to `transport-failure` — from the
 * caller's perspective, both just mean "resume didn't work."
 */
async function attemptResume(
  requestId: string,
  state: StreamState,
  onChunk: (textSoFar: string) => void,
  signal: AbortSignal
): Promise<ConsumeResult> {
  let response: Response;
  try {
    response = await fetch(`/api/generate/${requestId}/resume`, {
      headers: { "Last-Event-ID": String(state.lastEventId) },
      signal,
    });
  } catch {
    if (signal.aborted) return { outcome: "aborted" };
    return { outcome: "transport-failure" };
  }
  if (!response.ok) return { outcome: "transport-failure" };
  return consumeFrames(response, state, onChunk, signal);
}

export async function streamGeneration(
  body: GenerateRequestBody,
  signal: AbortSignal,
  { onChunk, onDone, onError }: StreamCallbacks
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // An AbortError here means *some* AbortController fired — but `signal.aborted`
    // is only true when *this call's own* controller (abortRef in StoryContext) was
    // the one aborted, i.e. a genuinely superseding call. A fetch the browser itself
    // cancels (net::ERR_ABORTED — seen racing Next's own navigation-triggered
    // requests, docs/adr/0026) throws the same AbortError shape without our signal
    // ever having been touched, and was being silently swallowed here — leaving the
    // UI stuck streaming forever with no error and nothing to recover it. Routing it
    // through the existing stream-aborted retry path instead actually recovers.
    if (signal.aborted) return;
    if (err instanceof Error && err.name === "AbortError") {
      onError({ kind: "stream-aborted", message: "Generation was interrupted before finishing." });
      return;
    }
    onError({ kind: "network", message: "Couldn't reach the server. Check your connection and try again." });
    return;
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    // Status-derived fallback — the only outcome for a 502 with no body (or a
    // non-JSON one), and the starting point `kind` below overrides once a
    // real body is parsed.
    let kind: GenerationErrorKind =
      response.status === 409
        ? "turn-violation"
        : response.status === 429
          ? "rate-limited"
          : response.status === 502
            ? "provider-failed"
            : "bad-request";
    let failedProviderId: string | undefined;
    let suggestedProviderId: string | undefined;
    let suggestedProviderName: string | undefined;
    // Read regardless of `kind` — cheap, and a malformed/absent header just
    // yields `undefined` (parseRetryAfterMs's own contract), same as today.
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    try {
      const data = await response.json();
      if (typeof data?.error === "string") message = data.error;
      if (typeof data?.kind === "string") kind = data.kind as GenerationErrorKind;
      if (typeof data?.failedProviderId === "string") failedProviderId = data.failedProviderId;
      if (typeof data?.suggestedProviderId === "string") suggestedProviderId = data.suggestedProviderId;
      if (typeof data?.suggestedProviderName === "string") suggestedProviderName = data.suggestedProviderName;
    } catch {
      // body wasn't JSON — keep the generic message and the status-derived kind
    }
    onError({ kind, message, failedProviderId, suggestedProviderId, suggestedProviderName, retryAfterMs });
    return;
  }

  const requestId = response.headers.get("x-request-id");
  const state: StreamState = { visibleText: "", lastEventId: 0 };

  let result = await consumeFrames(response, state, onChunk, signal);

  if (result.outcome === "transport-failure" && requestId) {
    result = await attemptResume(requestId, state, onChunk, signal);
  }

  if (result.outcome === "aborted") return;
  if (result.outcome === "done") {
    onDone(state.visibleText, state.metadata, result.persisted);
    return;
  }
  if (result.outcome === "error") {
    onError(result.error);
    return;
  }

  // transport-failure with no requestId to resume from, or resume itself
  // also failed — the existing generic surface, unchanged from before this
  // plan (the client's own single silent auto-retry in StoryContext.tsx keys
  // off exactly this kind).
  onError({ kind: "stream-aborted", message: "Generation was interrupted before finishing." });
}
