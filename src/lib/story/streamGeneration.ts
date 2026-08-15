import type { InventedMetadata, StoryParagraph } from "@/lib/providers/types";
import type { GenerationErrorKind } from "./types";

// Must match src/app/api/generate/route.ts's METADATA_SENTINEL exactly.
const SENTINEL = "\n FABULA:METADATA ";

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
}

export interface StreamCallbacks {
  onChunk: (textSoFar: string) => void;
  onDone: (finalText: string, metadata?: InventedMetadata) => void;
  onError: (error: GenerationError) => void;
}

/** Longest suffix of `buf` that could still be an incomplete prefix of SENTINEL. */
export function longestSentinelPrefixOverlap(buf: string): number {
  const maxCheck = Math.min(SENTINEL.length - 1, buf.length);
  for (let k = maxCheck; k > 0; k--) {
    if (buf.endsWith(SENTINEL.slice(0, k))) return k;
  }
  return 0;
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
    if (err instanceof Error && err.name === "AbortError") return;
    onError({ kind: "network", message: "Couldn't reach the server. Check your connection and try again." });
    return;
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {
      // body wasn't JSON — keep the generic message
    }
    const kind: GenerationErrorKind =
      response.status === 409 ? "turn-violation" : response.status === 502 ? "provider-failed" : "bad-request";
    onError({ kind, message });
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let visibleText = "";
  let pending = ""; // unflushed tail that might be a partial sentinel match
  let sentinelFound = false;
  let metadataJson = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) pending += decoder.decode(value, { stream: true });

      if (!sentinelFound) {
        const idx = pending.indexOf(SENTINEL);
        if (idx !== -1) {
          sentinelFound = true;
          const prose = pending.slice(0, idx);
          if (prose) {
            visibleText += prose;
            onChunk(visibleText);
          }
          metadataJson = pending.slice(idx + SENTINEL.length);
          pending = "";
        } else {
          // Hold back only the suffix that could still be the start of the
          // sentinel, so the raw "FABULA:METADATA" text can never flash on
          // screen even if it arrives split across reads.
          const overlap = longestSentinelPrefixOverlap(pending);
          const safeLen = pending.length - overlap;
          if (safeLen > 0) {
            visibleText += pending.slice(0, safeLen);
            pending = pending.slice(safeLen);
            onChunk(visibleText);
          }
        }
      } else {
        metadataJson += pending;
        pending = "";
      }

      if (done) break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    onError({ kind: "stream-aborted", message: "Generation was interrupted before finishing." });
    return;
  }

  const flushed = decoder.decode();
  if (flushed) {
    if (sentinelFound) metadataJson += flushed;
    else pending += flushed;
  }
  if (!sentinelFound && pending) {
    visibleText += pending;
    onChunk(visibleText);
  }

  let metadata: InventedMetadata | undefined;
  if (sentinelFound && metadataJson.trim()) {
    try {
      metadata = JSON.parse(metadataJson);
    } catch (e) {
      console.error("[streamGeneration] failed to parse invented-metadata JSON:", e);
      // metadata stays undefined — the prose itself already streamed correctly;
      // losing the invented-theme tag is a much smaller failure than crashing the UI.
    }
  }

  onDone(visibleText, metadata);
}
