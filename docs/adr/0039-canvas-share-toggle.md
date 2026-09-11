# 39. Share becomes a toggle in the canvas header

## Status

Accepted. Supersedes the Share half of ADR 0031's "Save and Share in the header are links, not
new state" decision; Save is unaffected.

## Context

ADR 0031 made the canvas header's `Share` a link to `/library` rather than a toggle, specifically
because `StoryContext` had no `isShared` and adding one was out of scope for that pass — sharing
already had a working toggle in the library (`ShareToggle.tsx`), so the canvas just pointed there.

`docs/plans/v4/08-ui-redesign-followups.md` flagged this as the one deferred item worth a product
call rather than a default: unlike the other two (prefill, target length), this touches
`src/lib/story/**`, which is held at 100% coverage, and adds real state rather than reading
existing state differently. The product decision was to build it — the underlying plumbing was
already there end-to-end: `GET /api/stories/:id` already returns `isShared`, and `PATCH
/api/stories/:id` already accepts it (`ShareToggle` already sends exactly that request from
`/library`).

## Decision

Add `isShared: boolean` to `StoryState`, defaulting to `false` (a guest or not-yet-persisted story
is never shared, so `false` rather than `undefined` keeps the field a plain boolean everywhere).

- `StoryContext`'s reducer gets a `SET_SHARED` action; `storyReducer` is now exported specifically
  so it can be unit-tested without a jsdom/React-testing-library dependency — the file itself
  stays excluded from the coverage gate for the reasons already recorded in `vitest.config.mts`
  (session-aware component logic, not something worth mocking `next-auth/react` to reach).
- A new `setShared(value)` on the context value dispatches `SET_SHARED` optimistically, then
  PATCHes `/api/stories/:id`, reverting the dispatch if the request fails or throws — the same
  optimistic-then-revert shape `ShareToggle` already uses, just living in the shared reducer
  instead of a component's local `useState`. It's a no-op without a `storyId`: nothing to share
  server-side before the story is first persisted.
- The canvas header's `Share` becomes a real toggle button — same copy and visual language as
  `ShareToggle` ("Share to feed" / "Shared to feed", `btn-primary` when shared, `btn-secondary`
  otherwise) — shown once `storyId` exists, matching the existing gating on the "Saved" indicator
  next to it. `ShareToggle` on `/library` is untouched; both now read and write the same
  `isShared`, so toggling from either place is consistent once the page re-fetches.
- The resume-from-library hydration path (`story/page.tsx`'s `hydrateStory` call) now carries
  `isShared` from the `GET` response, so resuming a shared story shows it as shared immediately.

A guest continues to see "Sign in to save" in the header's save slot; `isShared` has no meaning
before a story is persisted, so no guest-facing Share control is added.

## Consequences

- `src/lib/story/StoryContext.test.ts` is a new file exercising `storyReducer`'s `SET_SHARED`
  case directly — the first reducer-level unit test in this area, and a precedent for testing
  other cases the same way without needing the excluded file's coverage numbers to move.
- `e2e/specs/sharing-feed.spec.ts` gets a second test: toggling from the canvas (not `/library`)
  makes a story visible in another account's feed. The original library-based test is unchanged.
- Two independent places can now flip the same boolean (canvas and library); both PATCH the same
  endpoint with the same shape, so there's no new server-side surface, only a second optimistic
  client that can, in principle, race the other if both are open on the same story at once —
  accepted as out of scope, same as any other two-tabs-open case this app doesn't otherwise guard.
