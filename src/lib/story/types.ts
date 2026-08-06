import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { ProviderSummary } from "@/lib/providers/list";

export type GenerationErrorKind =
  | "bad-request" // 400
  | "turn-violation" // 409
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
  paragraphs: StoryParagraph[];
  invented?: InventedMetadata;
  generation: GenerationState;
}

export type { InventedMetadata, StoryParagraph, ProviderSummary };
