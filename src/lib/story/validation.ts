import type { StoryParagraph } from "@/lib/providers/types";
import {
  MAX_HINT_LENGTH,
  MAX_OPENING_LINES_LENGTH,
  MAX_TARGET_LENGTH,
  MIN_TARGET_LENGTH,
} from "./constants";

// Server-side request-body guards, shared by /api/generate and /api/stories. The UI
// enforces the same bounds, but nothing stops a client from posting past them — these
// run before anything reaches the database or a provider prompt.

export function isStoryParagraph(value: unknown): value is StoryParagraph {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    (p.author === "writer" || p.author === "ai") &&
    typeof p.text === "string" &&
    (p.providerId === undefined || typeof p.providerId === "string")
  );
}

export function isStoryParagraphArray(value: unknown): value is StoryParagraph[] {
  return Array.isArray(value) && value.every(isStoryParagraph);
}

/** Mirrors the slider's range in the UI (see MIN/MAX_TARGET_LENGTH). */
export function isValidTargetLength(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TARGET_LENGTH &&
    value <= MAX_TARGET_LENGTH
  );
}

/** Optional free-text hint: absent, or a string within `max` characters. */
export function isValidHint(value: unknown, max: number = MAX_HINT_LENGTH): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

/** The three scene-setting hints, which always travel together. */
export function areValidHints(body: Record<string, unknown>): boolean {
  return (
    isValidHint(body.theme) &&
    isValidHint(body.characters) &&
    isValidHint(body.openingLines, MAX_OPENING_LINES_LENGTH)
  );
}
