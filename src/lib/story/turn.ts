import type { StoryParagraph } from "@/lib/providers/types";

/**
 * Mirrors src/app/api/generate/route.ts's private isAIsTurn check. Kept as a
 * deliberate small duplicate rather than a shared import so this stays purely
 * client-side (the route module isn't safe to import into client code) — if
 * the server's turn policy ever changes, update both.
 */
export function isAIsTurn(paragraphs: StoryParagraph[]): boolean {
  if (paragraphs.length === 0) return true; // AI may write the very first paragraph (UC-2/UC-3)
  return paragraphs[paragraphs.length - 1].author !== "ai";
}

export function isWritersTurn(paragraphs: StoryParagraph[]): boolean {
  if (paragraphs.length === 0) return true; // Writer may write the very first paragraph (UC-1)
  return paragraphs[paragraphs.length - 1].author !== "writer";
}
