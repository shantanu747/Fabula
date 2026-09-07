/**
 * Generous single-paragraph cap — enforces PRD §7's "global reasonable
 * per-request token cap."
 *
 * Raised from 600 to 1500 (2026-08-30) after the eval harness surfaced a real
 * production bug: gpt-5-mini counts reasoning tokens against
 * max_completion_tokens, so at 600 it spent the whole budget on thinking and
 * returned empty paragraphs (finish_reason "length"). Even with
 * reasoning_effort "low", long-context stories truncated at 600. At 1500 the
 * worst case measured ~184 words — comfortably above the eval's 60-word floor
 * and within its 220-word ceiling, while still capping a single request.
 */
export const MAX_OUTPUT_TOKENS = 1500;

/**
 * Shared char budget driving windowStoryParagraphs()'s anchor+recency compaction.
 * Applied uniformly across all three providers for v1 simplicity even though their
 * real context windows differ — crude but safe, not per-provider-tuned.
 */
export const CONTEXT_WINDOW_CHAR_BUDGET = 12000;

/** Budget for the provider to produce its first token. Beyond this the Writer is
 *  staring at nothing, and a slow start rarely recovers into a fast stream. */
export const FIRST_CHUNK_TIMEOUT_MS = 20_000;

/** Max gap between chunks once streaming has begun. Generous — some models pause
 *  mid-paragraph — but bounded, so a half-open connection cannot hang forever. */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;
