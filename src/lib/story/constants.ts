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
