import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { ProviderSummary } from "@/lib/providers/list";

export type GenerationErrorKind =
  | "bad-request" // 400
  | "turn-violation" // 409
  | "rate-limited" // 429
  | "provider-failed" // 502
  | "stream-aborted" // mid-stream controller.error()
  | "network"; // fetch threw / offline

export type GenerationState =
  | { kind: "idle" }
  | { kind: "streaming"; text: string }
  | { kind: "error"; message: string; errorKind: GenerationErrorKind };

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
}

export type { InventedMetadata, StoryParagraph, ProviderSummary };
