# Plan 5 — Resilience and graceful degradation

**Branch:** `feature/resilience`
**Depends on:** Plan 4 (client recovery is written against its framed errors), Plan 2 (Redis for the
circuit breaker). *If Plan 4 isn't merged yet:* everything except the client error-handling
refinements is independent; do those and leave the framed-error handling to a follow-up rather than
writing it twice.
**ADRs:** two — durability and idempotency of Writer turns, and the provider circuit breaker.

## Why this exists

The error-handling that exists is good where it exists. The gaps are where it doesn't.

**Data loss.** A Writer paragraph is never persisted on its own. `WRITER_SUBMIT` is a local reducer
action (`src/lib/story/StoryContext.tsx:85-87`); the paragraph only reaches the database as a side
effect of the *next* `/api/generate` call's `syncStoryParagraphs`. Write a paragraph, close the tab,
and it is gone — from a signed-in Writer's saved story.

**Silent failure.** `ensureStoryId` returns `undefined` on any error (`StoryContext.tsx:163-168`)
and generation proceeds **unsaved, with no indication whatsoever**. The user believes they are
writing a saved story and they are not.

**A duplicate-row race.** `ensureStoryId` guards on `if (state.storyId) return` (`:150`) read from
the render closure. Two turn-initiating actions dispatched before `SET_STORY_ID` re-renders both see
`undefined` and both `POST /api/stories` — an unconditional insert (`stories/route.ts:39-51`) with
no idempotency key. The module has an `abortRef` for generation but no equivalent for this.

**Missing boundaries.** There is no `global-error.tsx`, and `src/app/layout.tsx:34` calls `auth()` —
a throw there has no boundary at all. There is one root `error.tsx` and no per-segment boundaries,
so any failure in `/feed`, `/library`, or `/story` replaces the whole page.

**Unhandled rejections.** `src/app/feed/page.tsx:23-30` has a `.finally()` and **no `.catch()`**;
the story hydrate at `src/app/story/page.tsx:39-53` has none either. `ReportButton.tsx:8-16` never
checks `response.ok` and renders "Reported — thanks for flagging this" after a 401 or 404.
`ShareToggle` reverts on failure but says nothing.

**`Retry-After` is sent and ignored.** The server sets it (`store.ts:84`); the client never reads
it, and the 429 banner has no retry affordance at all (`story/page.tsx:179`). There is no backoff
anywhere.

**No circuit breaker.** During a provider outage every user waits the full 20 s
`FIRST_CHUNK_TIMEOUT_MS` (`constants.ts:24`), then the route retries once, before being offered an
alternative. The app has no memory that the last fifty requests to that provider all failed.

**A dead capability.** The target-length slider (`story/page.tsx:245`) mutates local state only and
never PATCHes, though `PATCH /api/stories/[id]` has supported `targetLength` since it was written
(`stories/[id]/route.ts:57,88`).

## What "done" means

- A submitted Writer paragraph survives closing the tab.
- The user can always tell whether their story is saved.
- Two rapid actions cannot create two story rows, and neither can a network retry.
- Every segment has an error boundary; a layout throw has one too.
- No `fetch` in the client is missing a `.catch()`; no request renders success without checking it.
- A 429 shows when to try again; transient network failures back off.
- A provider outage fails fast after the breaker opens.

## Files

### Error boundaries — `src/app/`

- `global-error.tsx` (new). Must include its own `<html>`/`<body>` — it replaces the root layout,
  which is exactly why it is needed when that layout throws. Check the bundled Next docs for the
  current contract.
- `error.tsx` per segment: `feed/`, `feed/[id]/`, `library/`, `story/`. Each scoped to its own
  content so a feed failure does not blank the header.
- `loading.tsx` per segment. There is only a root one today.

Follow the existing root `error.tsx`: it deliberately uses a plain `<a href="/">` rather than
`next/link` (`:48-61`) because the router may itself be broken. Keep that reasoning.

These are UI: build them against the redesign tokens and check them at ~375px.

### `src/lib/story/StoryContext.tsx` (modify) — durability and idempotency

**Persist on submit.** `WRITER_SUBMIT` triggers a write for a signed-in Writer with a saved story.
This does not change who owns state — ADR 0007/0009's client-as-truth, DB-as-write-through-mirror
model is exactly what this is: a mirror write at the moment the data becomes real, rather than
deferred to an unrelated later request.

If Plan 3 landed, the same `(paragraphCount, contentHash)` verification applies; if not, reuse
`syncStoryParagraphs` unchanged. Either way the `UNIQUE(storyId, position)` index remains the
serialization point (ADRs 0013/0016) and **every existing race test must pass unmodified**.

**Fix the duplicate-story race** with both mechanisms, because they fail differently:

1. An in-flight promise ref, so concurrent callers await the same `POST` — mirroring the existing
   `abortRef` pattern in the same file. This fixes the local race.
2. An `Idempotency-Key` header on `POST /api/stories`, stored with a unique constraint, so a
   *network* retry cannot create a second row either. The promise ref cannot help there, because the
   duplicate originates outside the tab.

**Add `saveState`** (`"saved" | "saving" | "unsaved" | "error"`) and surface it. When
`ensureStoryId` fails, the user must be told the story is not being saved and offered a retry. If
Plan 4 landed, `done.persisted` feeds this too — that frame exists precisely because the server used
to swallow `"superseded"` and `"failed"` (`route.ts:406-419`) while the client committed anyway.

Note: `StoryContext.tsx` is **excluded from coverage** (`vitest.config.mts`) on the grounds that it
is reducer glue. That exclusion is now less true. Either extract the new logic (idempotency, save
state) into a covered module under `src/lib/story/` — preferred, and that directory is at 100% — or
change the exclusion deliberately and say why.

### `src/app/api/stories/route.ts` (modify)

Accept `Idempotency-Key`: same key plus same owner returns the existing row rather than inserting.
A unique index makes the guarantee real rather than best-effort.

### Client fetch hygiene

- `src/app/feed/page.tsx:23-30` — add `.catch()` and an error state. (Plan 3 may have already made
  this an RSC; if so, the island still needs it.)
- `src/app/story/page.tsx:39-53` — `.catch()` on hydrate; a failed hydrate must not leave the story
  silently empty.
- `src/components/ReportButton.tsx:8-16` — check `response.ok` before claiming success.
- `src/components/ShareToggle.tsx:15-31` — keep the optimistic update and revert, but say something
  when it reverts.

### `src/lib/story/retry.ts` (new)

Exponential backoff with **jitter** (jitter is the point — synchronised retries after an outage are
a self-inflicted thundering herd), a bounded attempt count, and a `Retry-After` parser handling both
the delay-seconds and HTTP-date forms.

Wire it in: 429 shows a live countdown from the server's `Retry-After` and re-enables the action
when it expires; `kind: "network"` backs off and retries; `turn-violation` and `bad-request` stay
non-retryable, as they are today.

Pure module under `src/lib/story/` — **100% coverage tier**.

### `src/lib/providers/circuitBreaker.ts` (new)

Per-provider failure counter in Redis over a short window. Open after N consecutive failures; while
open, skip the provider and return the `provider-unavailable` 502 with its suggested alternative
**immediately**, saving every user the 20 s first-chunk timeout. Half-open after a cooldown: let one
probe through, close on success, re-open on failure.

Count only failures that indicate provider health — a 5xx, a connection failure, a first-chunk
timeout. **Not** a 429 from the provider (that is quota, and opening the breaker on it converts a
throttle into an outage), and not a client disconnect.

Without Redis, the breaker is disabled and behaviour is exactly as today. It is an optimisation, not
a correctness mechanism.

This extends ADR 0023's Writer-mediated failover rather than replacing it: the Writer is still
*asked* before switching providers. The breaker only changes how quickly the question gets asked.
Say that explicitly — it would be easy to read as reversing that decision.

### Small fixes

- `src/app/story/page.tsx:245` — PATCH `targetLength` on change (debounced).
- `src/app/api/generate/route.ts:264` — the client-abort listener is added and never removed. Use
  `{ once: true }` or remove it in the terminal path.

## Tests

- `retry.test.ts` — backoff sequence, jitter bounds, attempt cap, `Retry-After` in both formats,
  malformed header.
- `circuitBreaker.test.ts` — opens after N, fails fast while open, half-open probe closes on
  success and re-opens on failure, a provider 429 does not open it, disabled without Redis.
- Idempotency tests — concurrent `ensureStoryId` produces one row; a replayed `Idempotency-Key`
  returns the same row; different owners with the same key do not collide.
- Persistence tests — a submitted Writer paragraph is present in the database before any generation;
  **all existing race tests pass unmodified**.
- E2E — submit a paragraph, reload, confirm it is still there; force a story-creation failure and
  assert the unsaved indicator appears; report/share failures do not render false success.
- Boundary tests — a thrown error in each segment renders that segment's boundary and leaves the
  header usable.

## Verification

Full CI reproduction, plus:

- `npm run test:e2e:soak` if Plan 4 is in the same lineage — this touches the same client streaming
  path.
- By hand: write a paragraph, close the tab, reopen the story from `/library`, confirm it is there.
  This is the user-visible data-loss bug and it deserves a manual check.
- By hand: trip the rate limit and confirm the countdown matches `Retry-After` and the action
  re-enables.
- By hand: point a provider at an unreachable base URL, confirm the breaker opens and later requests
  fail in well under a second instead of 20.
- Every new UI surface at ~375px; `rm -rf .next && npm run build && npm run bundle-budget`.

## Gotchas

- Persist-on-submit adds a request on a path that previously had none. It must not block the UI —
  the paragraph appears locally first and saves behind that, with `saveState` reflecting reality.
- The idempotency key must be generated once per logical story creation, not per attempt, or it
  defeats itself.
- A breaker keyed globally in Redis means one deployment's failures affect all instances — usually
  what you want, but it means a poisoned counter affects everyone. Bound the window and make the
  state inspectable.
- Do not auto-switch providers when the breaker opens. ADR 0023 chose asking over switching
  deliberately; this plan changes latency, not that decision.
- `src/lib/story/**` is at 100% coverage. New modules there need complete tests including error
  paths.
- Segment `error.tsx` files are client components and count toward that route's first-load JS. Check
  `budgets.json`.

## Out of scope

- Offline support, service workers, or local drafts beyond the server write.
- Automatic provider failover without asking (ADR 0023).
- Retrying a *completed but unpersisted* generation — Plan 4's `done.persisted` surfaces it; acting
  on it automatically would risk double-spending.
- A moderation queue for reports (PRD §3 non-goal).

## ADRs

**`docs/adr/00NN-durable-writer-turns-and-idempotent-creation.md`**

- Why a Writer paragraph was only ever persisted as a side effect, and why persist-on-submit is
  consistent with (not a reversal of) ADR 0007/0009's mirror model.
- Why both an in-flight ref and an idempotency key: they fix different races, and neither alone is
  sufficient.
- Why `saveState` is user-visible: silent unsaved state is worse than a visible failure.
- Whether the `StoryContext.tsx` coverage exclusion still holds, and what changed.

**`docs/adr/00NN-provider-circuit-breaker.md`**

- Why a breaker on top of ADR 0023's timeouts: timeouts bound one request, a breaker bounds the
  *population* of requests during an outage.
- Which failures count toward it and why a provider 429 does not.
- Why it extends rather than replaces Writer-mediated failover.
- Why it degrades to disabled without Redis, and why that is acceptable for an optimisation.
