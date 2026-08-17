import type { InventedMetadata } from "@/lib/providers/types";

/**
 * Deterministic structural checks for a generated paragraph (docs/plans/v3/01
 * Layer 2). No judge involved — these are the "the output is shaped like a
 * Fabula AI turn" invariants, and a mean score can't hide a failure here:
 * thresholds require 100% pass.
 */

export interface StructuralOptions {
  /** True only for the zero-input kickoff case: metadata must have parsed
   *  with a non-empty theme and characters. */
  expectMetadataHeader: boolean;
  metadata?: InventedMetadata | undefined;
}

export interface StructuralResult {
  passed: boolean;
  failures: string[];
}

const MIN_WORDS = 60;
const MAX_WORDS = 220;

/** A single newline is fine (wrap, poetry) — a blank line means two paragraphs. */
const BLANK_LINE = /\n\s*\n/;
const AUTHOR_LABEL = /^\s*(AI|A\.I\.|Assistant|Writer|Narrator|Claude|Model)\s*:/i;
const MARKDOWN_HEADING = /^#{1,6}\s/m;
const LEAKED_FIELD = /^(THEME|CHARACTERS)\s*:/im;
const LEAKED_DELIMITER = /^\s*---\s*$/m;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function isQuoteWrapped(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (
    (first === '"' && last === '"') ||
    (first === "“" && last === "”") ||
    (first === "'" && last === "'")
  );
}

export function checkStructural(text: string, options: StructuralOptions): StructuralResult {
  const failures: string[] = [];

  if (BLANK_LINE.test(text)) {
    failures.push("contains a blank-line break — must be exactly one paragraph");
  }

  const words = countWords(text);
  if (words < MIN_WORDS || words > MAX_WORDS) {
    failures.push(`word count ${words} outside ${MIN_WORDS}–${MAX_WORDS}`);
  }

  if (AUTHOR_LABEL.test(text)) {
    failures.push('starts with an author label (e.g. "AI:")');
  }

  if (isQuoteWrapped(text)) {
    failures.push("wrapped in quotation marks");
  }

  if (MARKDOWN_HEADING.test(text)) {
    failures.push("contains a markdown heading");
  }

  if (LEAKED_FIELD.test(text) || LEAKED_DELIMITER.test(text)) {
    failures.push("leaked THEME:/CHARACTERS:/--- scaffolding into the prose");
  }

  if (options.expectMetadataHeader) {
    const metadata = options.metadata;
    if (!metadata?.theme || !metadata?.characters) {
      failures.push("zero-input kickoff metadata missing or incomplete (theme/characters)");
    }
  }

  return { passed: failures.length === 0, failures };
}
