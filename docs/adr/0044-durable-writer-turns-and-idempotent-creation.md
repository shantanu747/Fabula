# 44. Durable Writer turns and idempotent story creation

## Status

Accepted.

## Context

A Writer paragraph was never persisted on its own. `WRITER_SUBMIT` (`StoryContext.tsx`) is a local
reducer action; the paragraph only reached the database as a side effect of the *next*
`/api/generate` call's diff-based sync. Write a paragraph, close the tab before that next call
completes — a lock screen, a dropped connection, simply never clicking "Add & continue" again — and
it is gone from a signed-in Writer's saved story, with nothing in the product to indicate it was
ever at risk.

Separately, `ensureStoryId` swallowed every failure and returned `undefined` silently: generation
proceeded, unsaved, with no indication whatsoever. And `ensureStoryId` guarded story creation only
with `if (state.storyId) return`, read from the render closure — two turn-initiating actions
dispatched before the resulting `SET_STORY_ID` re-renders both see `undefined` and both
`POST /api/stories`, an unconditional insert with no idempotency key. `StoryContext.tsx` already had
an `abortRef` for canceling a superseded generation; nothing equivalent existed for story creation.

Spec: `docs/plans/v4/05-resilience.md`.

## Decision

**Persist on submit, not on the next unrelated request.** `WRITER_SUBMIT` (via `submitAndContinue`
and `submitWriterParagraph`) now fires a dedicated write the instant it happens, through a new route
that does nothing else: `POST /api/stories/[id]/paragraphs`. This is not a reversal of ADR
0007/0009's client-as-truth, database-as-write-through-mirror model — it's the same model, just
triggered at the moment the data becomes real instead of deferred to whatever request happens to
come next. `StoryContext` remains authoritative for the duration of the session; the database still
only ever mirrors it.

The new route calls `syncStoryParagraphs` unchanged — the same diff-based, `(paragraphCount,
contentHash)`-verified function `/api/generate` already used, so `UNIQUE(storyId, position)`
(ADRs 0013/0016) remains the one serialization point regardless of which caller gets there first.
Racing the new route against `/api/generate`'s own sync of the same paragraph is safe by
construction: whichever write loses collides on the unique index, re-reads, and finds its content
already there — exactly the mechanism that already makes two concurrent turns on one story safe. No
existing race test needed to change, and none did.

Persistence must never block the AI starting to write. `submitAndContinue` resolves `ensureStoryId`
once, then starts generation and the paragraph-sync write concurrently, not sequentially — the
Writer sees the AI begin exactly as fast as before this existed.

**Two mechanisms for the duplicate-story race, because they fail differently.** An in-flight
promise, held for the lifetime of one attempt, so concurrent callers within the same tab await the
same `POST` rather than each starting their own — this is the local race, and it mirrors the
existing `abortRef` pattern in the same file. Separately, an `Idempotency-Key` header, generated
once per *logical* creation (not once per attempt — reusing it across a failed attempt's retries is
what makes the retry safe, and generating a fresh one per retry would defeat the whole point) and
stored under a `UNIQUE(ownerId, idempotencyKey)` constraint. The in-flight ref cannot fix a
network-level retry, because the duplicate call originates outside the tab entirely, after the
original request's promise has already settled one way or another; the idempotency key cannot fix
the local race on its own either, since without the ref, two concurrent local callers would both
still issue a `POST`, just with the same key — safe from *duplicating a row*, but not from paying
for two round trips or racing on which response updates state last.

Both mechanisms, plus `saveState` (below), live in a new module — `src/lib/story/persistence.ts` —
extracted out of `StoryContext.tsx` rather than left inline. `StoryContext.tsx` is excluded from
unit-test coverage on the grounds that it's reducer glue exercised at the E2E layer instead; that
exclusion is a good tradeoff for dispatch wiring and stale-closure-sensitive state threading, but
idempotency-key lifecycle and retry classification are exactly the kind of logic worth testing
directly. `persistence.ts` sits in `src/lib/story/**`, held to that directory's 100% coverage tier.

**`saveState` (`"saved" | "saving" | "unsaved" | "error"`) is new, user-visible state.** Silent
unsaved state was the actual bug — not "no idempotency key," which only makes the retry unsafe.
`ensureStoryId` dispatches `"saving"` before attempting and `"error"` on failure, but deliberately
never dispatches `"saved"` itself: the row existing is not the same claim as "everything the Writer
has done is mirrored," and for `generateNext`/`switchProviderAndRetry` (which call `ensureStoryId`
but write no Writer paragraph of their own), that claim isn't true yet. Two other places close the
loop: the new paragraph-sync write dispatches `"saved"`/`"error"` from its own outcome, and
`streamGeneration.ts`'s `onDone` callback now threads the `done` frame's `persisted` field through
(docs/adr/0042) — the frame existed since Plan 4 specifically so the client could stop committing a
paragraph the server had already reported as `"superseded"` or `"failed"`; this is what finally
reads it. `persisted` is `false` for a guest turn too (no mirror was ever attempted), so the
`onDone` handler only acts on it when the turn's own `storyId` parameter is defined — reading the
local closure parameter, not `state.storyId`, for the same stale-closure reason `providerId` already
does throughout this file.

A `retrySave()` action re-attempts whatever last failed, reusing the same idempotency key (nothing
new needs creating) and re-syncing the full current paragraph list (always safe — it's the same
diff-based write, idempotent by construction).

**The header's save indicator had a latent, unrelated bug fixed in passing.** The pre-existing
"Saved" label carried `hidden ... lg:inline` in both the header and the phone-nav copy of the same
element — meaning it never actually rendered on a phone despite being included in the mobile-only
`<nav>` block there. Wiring in live `saveState` was the moment to notice this, since it's exactly
the surface this plan makes load-bearing. Fixed by rendering two distinct elements: the header's
stays quiet (hidden below `lg`, the lowest-priority item to drop when the header is cramped) for
`"saving"`/`"saved"`, but an `"error"` escapes that hiding even in the header — it matters more than
the space costs. The phone-nav instance always shows the current status; it has no such space
constraint.

## Rejected

- **Retrying story creation without an idempotency key, relying on the in-flight ref alone.** Fixes
  the local race, not a network-level retry (browser-level, or `retry.ts`'s own backoff) racing
  against a request whose response never arrived — that duplicate originates after the ref's promise
  has already resolved.
- **Auto-retrying every failure silently, with no visible `saveState`.** Would repeat the exact
  failure mode this plan closes: a Writer with no way to know their story isn't actually saved.
- **Folding the "last touched" `updatedAt` bump into `appendParagraphsOnce` itself
  (`src/lib/db/paragraphs.ts`).** That function is also `/api/generate`'s hot path, called on every
  turn; giving it an unconditional extra write for a bump that route already gets from its own
  subsequent `insertAIParagraph` call would be pure overhead there. The new paragraphs-sync route
  bumps `updatedAt` itself, as a separate statement, only when it actually appended something.

## Consequences

- A submitted Writer paragraph is durable before the AI's reply exists, checked directly (write,
  close the tab equivalent, reopen from `/library`, confirm it's there) and in
  `e2e/specs/resilience.spec.ts`.
- `stories` gained an `idempotencyKey` column and a `UNIQUE(ownerId, idempotencyKey)` constraint
  (migration `0006`). Nullable, and null is never constrained against null (Postgres's own default
  behavior for a unique index) — every pre-existing row, and any caller that omits the header,
  behaves exactly as before.
- `POST /api/stories/[id]/paragraphs` is a new authenticated, rate-limited (`guardStoriesWrite`,
  same bucket as the other story-write routes), ownership-checked route whose only job is calling
  `syncStoryParagraphs` outside of a generation call.
- The first-load JS budget for `/story` and `/library` moved (`budgets.json`, re-measured and
  updated alongside this change, not just raised past a failing number) — both routes gained real,
  user-visible UI (the save/retry indicator, the rate-limit countdown, error boundaries, loading
  skeletons) that costs client bytes on purpose.
