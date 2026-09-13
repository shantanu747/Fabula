import type { StoryParagraph } from "@/lib/providers/types";
import { NETWORK_RETRY_POLICY, withBackoff } from "./retry";

/**
 * The durability half of Plan 5
 * (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md), pulled out
 * of `StoryContext.tsx` so it sits in a covered module — that file is
 * reducer glue excluded from coverage (vitest.config.mts), and this is no
 * longer just glue. `SaveState` itself lives in `./types` (it's part of
 * `StoryState`, not this module's own concern) — re-exported here so a
 * caller of `ensureStoryId`/`persistParagraphs` doesn't need a second import.
 */

export type { SaveState } from "./types";

export interface StoryCreationInput {
  theme?: string;
  characters?: string;
  openingLines?: string;
  targetLength: number;
  selectedProviderId: string;
}

/** A 5xx (or a thrown network error) is worth retrying with backoff — the
 *  server or the connection had a transient problem. A 4xx never is: the
 *  request itself is wrong (or, for this route specifically, the caller
 *  isn't signed in), and retrying it just repeats the same rejection. */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

async function attemptCreate(
  input: StoryCreationInput,
  idempotencyKey: string,
  fetchImpl: typeof fetch
): Promise<string | undefined> {
  const response = await fetchImpl("/api/stories", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
  if (isRetryableStatus(response.status)) {
    throw new Error(`story creation failed: ${response.status}`);
  }
  if (!response.ok) return undefined;
  const data = (await response.json()) as { id: string };
  return data.id;
}

export interface StoryCreationCoordinator {
  /**
   * Lazily creates the server-side story row, guarding both races a bare
   * `fetch` call can't:
   *
   *  - Local: concurrent callers within the same tick (two turn-initiating
   *    actions dispatched before state re-renders) await the very same
   *    in-flight promise rather than each starting their own POST.
   *  - Network: a dropped response that makes the browser (or `retry.ts`'s
   *    own backoff below) retry the request cannot create a second row,
   *    because every attempt toward one "logical creation" reuses the same
   *    `Idempotency-Key` — generated once, on first use, and held until it
   *    either succeeds or `reset()` is called for a genuinely new story.
   *
   * Resolves to `undefined` on any failure (network, timeout, a 4xx) — the
   * caller (StoryContext) is responsible for surfacing that as `saveState`.
   */
  ensureStoryId(input: StoryCreationInput, fetchImpl?: typeof fetch): Promise<string | undefined>;
  /** Starts a fresh "logical creation" — a new idempotency key on the next
   *  call, not the one an abandoned or completed attempt already used.
   *  Call this from `resetStory`/`hydrateStory`, never mid-attempt. */
  reset(): void;
}

export function createStoryCreationCoordinator(): StoryCreationCoordinator {
  let idempotencyKey: string | undefined;
  let inFlight: Promise<string | undefined> | undefined;

  return {
    ensureStoryId(input, fetchImpl = fetch) {
      if (inFlight) return inFlight;

      idempotencyKey ??= crypto.randomUUID();
      const key = idempotencyKey;

      const promise = withBackoff(
        () => attemptCreate(input, key, fetchImpl),
        () => true, // every throw from attemptCreate is, by construction, retryable
        NETWORK_RETRY_POLICY
      )
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });

      inFlight = promise;
      return promise;
    },
    reset() {
      idempotencyKey = undefined;
      inFlight = undefined;
    },
  };
}

async function attemptPersistParagraphs(
  storyId: string,
  storySoFar: StoryParagraph[],
  fetchImpl: typeof fetch
): Promise<boolean> {
  const response = await fetchImpl(`/api/stories/${storyId}/paragraphs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storySoFar }),
  });
  if (isRetryableStatus(response.status)) {
    throw new Error(`paragraph sync failed: ${response.status}`);
  }
  return response.ok;
}

/**
 * Mirrors a Writer's paragraphs to the server the moment `WRITER_SUBMIT`
 * fires, independent of whatever happens with the AI's turn afterward — the
 * data-loss bug this plan exists to close (see the ADR). `syncStoryParagraphs`
 * server-side is what actually makes this idempotent (diff-based against
 * what's already stored, serialized by `UNIQUE(storyId, position)`); this
 * function only adds the same retry-on-transient-failure behavior as story
 * creation. Never throws — resolves `false` for any failure, retryable or not.
 */
export async function persistParagraphs(
  storyId: string,
  storySoFar: StoryParagraph[],
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    return await withBackoff(
      () => attemptPersistParagraphs(storyId, storySoFar, fetchImpl),
      () => true,
      NETWORK_RETRY_POLICY
    );
  } catch {
    return false;
  }
}
