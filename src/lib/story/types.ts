import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { ProviderSummary } from "@/lib/providers/list";

export type GenerationErrorKind =
  | "bad-request" // 400
  | "turn-violation" // 409
  | "rate-limited" // 429
  | "provider-failed" // 502 with no body, or a body with no `kind`
  | "provider-unavailable" // 502 with kind: "provider-unavailable" — may carry a named alternative
  | "stream-aborted" // mid-stream controller.error()
  | "network"; // fetch threw / offline

export type GenerationState =
  | { kind: "idle" }
  | { kind: "streaming"; text: string }
  | {
      kind: "error";
      message: string;
      errorKind: GenerationErrorKind;
      /** Set only for a "provider-unavailable" error — see streamGeneration.ts. */
      failedProviderId?: string;
      suggestedProviderId?: string;
      suggestedProviderName?: string;
      /** Set only for a "rate-limited" error with a parseable `Retry-After` —
       *  see streamGeneration.ts's `GenerationError`. */
      retryAfterMs?: number;
    };

/**
 * Whether this story's current content is durably mirrored server-side
 * (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md) —
 * meaningful only for a signed-in Writer (docs/adr/0009); a guest is never
 * saved server-side at all, and the UI never surfaces this for one.
 *
 *  - "unsaved": nothing has been attempted yet — a fresh story, or a guest.
 *  - "saving": a story-creation or paragraph-sync request is in flight.
 *  - "saved": the last attempt succeeded and nothing has failed since.
 *  - "error": the last attempt failed. The Writer must be told — silent
 *    unsaved state is the bug this exists to close — and offered a retry.
 */
export type SaveState = "saved" | "saving" | "unsaved" | "error";

export interface StoryState {
  theme: string;
  characters: string;
  openingLines: string;
  selectedProviderId: string;
  targetLength: number;
  paragraphs: StoryParagraph[];
  invented?: InventedMetadata;
  generation: GenerationState;
  /** Set once this story has been saved server-side (logged-in Writers only —
   *  see docs/adr/0009). Undefined means guest mode or "not saved yet". */
  storyId?: string;
  /** Mirrors `stories.isShared`. Meaningless until `storyId` is set — a guest
   *  or not-yet-persisted story is never shared, so this defaults to `false`
   *  rather than `undefined` (see docs/adr/0039). */
  isShared: boolean;
  saveState: SaveState;
  /** Set when the last `setShared` PATCH failed and the optimistic toggle was
   *  reverted — cleared on the next attempt. Distinct from `saveState`: this
   *  is about the Share toggle specifically, not the story's own paragraphs. */
  shareError: boolean;
}

export type { InventedMetadata, StoryParagraph, ProviderSummary };
