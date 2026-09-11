import type { StoryParagraph } from "@/lib/providers/types";

/**
 * A stable, order-and-content-sensitive fingerprint of a paragraph sequence.
 * Used to skip re-reading every stored paragraph row just to confirm the
 * client's array is a prefix-extension of what's already saved
 * (docs/adr/0041) — the client attaches this (over the paragraphs it believes
 * are already persisted) to its /api/generate request body, and the server
 * compares it against the denormalized `story.contentHash` it already
 * fetched. A hash computed two different ways is a permanent 409, so this
 * function is the ONLY place either side may compute it.
 *
 * Only `author` and `text` feed the hash, matching exactly what
 * `syncStoryParagraphs`' own row-by-row prefix check already compares
 * (`src/lib/db/paragraphs.ts`) — `providerId` is not part of that equality
 * and must not be part of this one either, or the two checks would disagree
 * about what counts as "the same content".
 *
 * Uses the Web Crypto API (`crypto.subtle`), available identically in the
 * browser and in Node 18+ — not Node's `crypto` module, which the browser
 * doesn't have and this module must run in both.
 */
export async function hashStoryParagraphs(paragraphs: readonly StoryParagraph[]): Promise<string> {
  // NUL between author/text and newline between paragraphs: both are bytes no
  // valid `author` value contains and no paragraph text can smuggle in a way
  // that shifts a field boundary, so two different paragraph sequences can't
  // serialize to the same string.
  const serialized = paragraphs.map((p) => `${p.author}\0${p.text}`).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
