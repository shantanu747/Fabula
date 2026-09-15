// Chosen to comfortably cover a co-written short story with a real beginning/
// middle/end (~7 exchanges each way) without being so long the soft-target
// climax steering (see prompt.ts) never has a chance to kick in.
//
// Kept in a plain module rather than StoryContext.tsx so route handlers can enforce
// the same bounds the UI does: under RSC, importing a value from a "use client"
// module server-side yields a client reference, not the number.
export const DEFAULT_TARGET_LENGTH = 14;
export const MIN_TARGET_LENGTH = 6;
export const MAX_TARGET_LENGTH = 30;

// Generous caps on the optional scene-setting hints — long enough never to truncate
// real input, bounded so an arbitrary-size string can't be posted straight into the
// stories table or a provider prompt.
export const MAX_HINT_LENGTH = 500;
export const MAX_OPENING_LINES_LENGTH = 2000;

// Bounds on the Writer's own paragraph turns (docs/adr/0048) — nothing capped
// either of these before, despite both being written straight into
// story_paragraph and a provider prompt. Generous relative to the AI's own
// ~80-180-word target (MAX_PARAGRAPH_TEXT_LENGTH is roughly 20x that) and to
// MAX_TARGET_LENGTH's 30-paragraph soft target (MAX_STORY_PARAGRAPHS is
// roughly 7x that), so a real Writer never notices either limit.
export const MAX_PARAGRAPH_TEXT_LENGTH = 4000;
export const MAX_STORY_PARAGRAPHS = 200;
