# 38. "Start one like this" prefills the new story

## Status

Accepted. Supersedes the "unprefilled" note in ADR 0033.

## Context

ADR 0033 deliberately left the shared-story page's "Start one like this" link pointed at `/` with
nothing carried over — prefilling would have meant the start page reading query parameters and
writing them into `StoryContext` on mount, "a new state path the handoff does not describe,"
noted there as a small follow-up if a use case for it appeared.

`docs/plans/v4/08-ui-redesign-followups.md` picked this back up as one of three deferred intents
needing an explicit decision. The button currently does not do what its copy promises: clicking
it opens a completely blank start flow, even though the server already has that story's `theme`
and `characters` in scope (`src/app/feed/[id]/page.tsx`). The alternative considered was leaving
the behavior as-is and just renaming the copy to "Start a story."

## Decision

Build the prefill instead of renaming the copy — the copy already reads correctly for what the
feature should do, and the underlying data is already available server-side with no additional
fetch.

- `feed/[id]/page.tsx` builds the link's href with `URLSearchParams` — `theme` and `characters`
  are included only when the shared story actually has a non-empty value for each.
- `src/app/page.tsx` (`Home`) reads `theme`/`characters` off `useSearchParams()` in a mount-only
  effect and dispatches `setTheme`/`setCharacters` **only when the corresponding field is still
  empty** — a Writer who has already started typing, or a remount that still holds state, is
  never overwritten.
- Values are clamped to `MAX_HINT_LENGTH` (`src/lib/story/constants.ts`) before dispatch, the same
  bound `isValidHint` enforces server-side. This is now load-bearing in a way it wasn't for
  in-app typing: the value arrives from a URL a person can hand-edit, not just from a field with
  its own `maxLength`.
- `useSearchParams()` requires a Suspense boundary for the page to prerender; `Home` follows the
  same pattern `story/page.tsx` already uses (`StoryPage` split from a `Suspense`-wrapped default
  export).

The Writer still lands on step one (Scene) of the five-step flow, sees the theme/characters
already filled, and walks forward through the remaining steps exactly as before — prefilling
seeds the fields, it does not skip any screen.

## Consequences

- A second input path into `StoryContext` besides direct typing and `hydrateStory` (the
  resume-from-library path) now exists: an effect that dispatches from URL state. It only ever
  writes when the target field is empty, so it can't clobber in-progress input.
- A prefilled theme/characters string is bounded by the same `MAX_HINT_LENGTH` a typed one is —
  the URL cannot produce a longer hint than the form itself would have accepted.
- `Home`'s default export now wraps in `Suspense`, matching the story canvas's existing shape.
