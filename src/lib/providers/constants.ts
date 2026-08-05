/** Generous single-paragraph cap — enforces PRD §7's "global reasonable per-request token cap." */
export const MAX_OUTPUT_TOKENS = 600;

/**
 * Shared char budget driving windowStoryParagraphs()'s anchor+recency compaction.
 * Applied uniformly across all three providers for v1 simplicity even though their
 * real context windows differ — crude but safe, not per-provider-tuned.
 */
export const CONTEXT_WINDOW_CHAR_BUDGET = 12000;
