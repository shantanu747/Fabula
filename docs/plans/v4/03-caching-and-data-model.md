# Plan 3 — Caching, prompt caching, and the data model

**Branch:** `feature/caching-and-data-model`
**Depends on:** Plan 2 (the `src/lib/kv/` client), Plan 1 (the baseline). *If Plan 2 isn't merged
yet:* build the query and schema work first — it is independent — and gate the Redis-backed feed
cache behind `hasKv()` so it is inert without the client.
**ADRs:** two — stable-prefix windowing, and the data-model/caching changes.

## Why this exists

There is no cache anywhere in this application. Verified across `src/`: no `unstable_cache`, no
`revalidateTag`, no `revalidatePath`, no React `cache()`, no `useMemo`/`useCallback`/`memo`, no
in-memory map, no LRU, no `Cache-Control` on any read route, and **no provider prompt caching**.

At the same time the per-turn cost grows with story length:

- `syncStoryParagraphs` (`src/lib/db/paragraphs.ts:105-113`) selects `position`, `authorType`, and
  the **full `text`** of every stored paragraph, on **every** turn, to prove the client's array is a
  prefix-extension of stored state. A 30-paragraph story reads ~24 KB out of Postgres per turn to
  compare against the ~24 KB the client just uploaded. Across a whole story that is O(n²) on both
  the wire and Neon's egress meter.
- Both the feed and the library `leftJoin story_paragraph` and `groupBy` solely to produce a
  paragraph **count**, aggregating every paragraph row of every matching story before the `LIMIT`
  applies.
- The library query (`src/app/api/stories/route.ts:60-75`, duplicated at
  `src/app/library/page.tsx:16-30`) has **no `LIMIT` at all**.
- The feed pages by `OFFSET` with no maximum (`src/app/api/feed/route.ts:15`).

And `src/lib/db/queries.perf.test.ts` EXPLAINs *simplified stand-ins* (`:165-182`) rather than the
queries the app actually runs — so the index guarantees ADR 0017 claims are not currently proven
for the shipped code path.

## The prompt-caching subtlety — read this before touching `prompt.ts`

The obvious framing ("the prefix slides every turn so caching can never work") is **wrong**, and
getting this right is the point of the first ADR.

`windowStoryParagraphs` (`src/lib/providers/prompt.ts:32-60`) returns the array **unchanged** while
the story is under `CONTEXT_WINDOW_CHAR_BUDGET` (12 000 chars, `constants.ts:20`). So for a short
story each turn's message list is a pure **append** to the previous turn's — exactly the shape
prefix caching wants. Caching would work today for those stories if the flags were simply set.

The prefix destabilises **only after** the budget is exceeded, and then in two ways at once
(`prompt.ts:38-59`):

1. the window drops one more paragraph from the middle each turn, and
2. the anchor's text is **mutated** by appending `[...earlier paragraphs continue here, omitted for
   length...]`.

From that turn on, every request is a full cache miss forever — which is precisely when stories are
longest and input cost is highest.

So the fix is two parts, and only the second is interesting:

1. Set the cache flags.
2. **Make the window advance in chunks.** When the budget is exceeded, drop a *batch* of paragraphs
   and hold that boundary steady for many subsequent turns, instead of sliding by one each time.
   Trading a little context efficiency for a stable prefix is right because a cache read costs ~10%
   of the input price and a cache write ~125%: hitting 9 turns in 10 is a large win, hitting 0 in
   10 is what happens now.

Anthropic's ephemeral cache TTL is 5 minutes and refreshes on read — longer than the gap between
turns in an active co-writing session, which is the usage pattern this app has. Note that in the
ADR: the cache fits because of how the product is used, not by luck.

**Check the current cache-control API shape in the bundled SDK docs before writing it.** Do not
write cache-block syntax from memory.

## What "done" means

- A second turn on the same story produces a **non-zero cache read** — demonstrated, not assumed.
- A saved-story turn costs about three database round trips instead of six, measured by the Plan 1
  harness.
- Neither the feed nor the library joins the paragraph table to produce a count.
- The library query has a `LIMIT`; the feed uses keyset pagination.
- `queries.perf.test.ts` EXPLAINs the queries the app actually runs.
- The feed's first page renders on the server.

## Files

### `src/lib/providers/prompt.ts` (modify) — chunked windowing

Rework `windowStoryParagraphs` so the retained boundary is **sticky**. Suggested shape: once the
budget is exceeded, drop down to a low-water mark (e.g. ~60% of budget) and keep that same start
index until the budget is exceeded again. Consecutive turns then share an identical prefix and only
append.

The anchor note must be **stable too**: if its text changes the turn the window first slides, the
prefix breaks at exactly the moment caching starts to matter. Prefer a fixed note whose content does
not vary with how many paragraphs were dropped.

Also fix the latent bug at `prompt.ts:39`: `budgetForRest = BUDGET - anchor.text.length` can go
**negative**, so a single oversized first paragraph bypasses the input budget entirely. Clamp it,
and truncate an anchor that alone exceeds the budget. (Plan 6 adds the input-length cap that makes
this rare; both are needed — a cap at the boundary and a clamp at the consumer.)

`src/lib/providers/prompt.ts` is at **100% coverage** and has property-based tests. Extend them:
the key new property is **"turn N and turn N+1 share a byte-identical prefix"** across many
generated story shapes. That property is the whole point of the change, so assert it directly with
`fast-check` rather than testing a specific example.

### `src/lib/providers/{anthropic,openai,openrouter}.ts` (modify)

- Anthropic: mark the system prompt and the end of the stable story prefix as cacheable, per the
  bundled SDK docs.
- OpenAI: caching is automatic for prefixes over its threshold — no flag, but the stability work
  above is what makes it apply. Read `cached_tokens` back from the usage payload.
- OpenRouter: verify whether the chosen model reports cache usage. If it does not, return
  `undefined` and warn once — `openrouter.ts:37` already has the once-per-isolate warning latch to
  follow. **Never fabricate a number**; that is the standing rule from ADR 0022.

### `src/lib/providers/types.ts` + `pricing.ts` (modify)

Widen `TokenUsage` with `cacheCreationInputTokens?` and `cacheReadInputTokens?` (both optional —
absent means not reported, never zero). Extend `estimateCostUsd` for the cache-write and cache-read
multipliers, citing each rate with the date checked, matching the existing `PRICING` comment style.

`pricing.ts` is in the **100%** tier. Update `AGENTS.md`'s inlined `TokenUsage`/`GenerationResult`
snippet — that block is normative and a stale copy is worse than none.

### `src/lib/db/schema.ts` + a migration

- `story.paragraphCount` — integer, not null, default 0.
- `story.contentHash` — text, nullable (existing rows have none until first write).
- `generation_event.cacheReadInputTokens` / `cacheCreationInputTokens` — integer, nullable.
- New indexes: `generation_event(storyId)` (the FK is unindexed today), `story_report(storyId)`,
  and the feed/library keyset indexes below.

The migration must **backfill** `paragraphCount` and `contentHash` for existing rows. Migration
0001 already contains a full-table backfill of `story_paragraph`; follow its shape, and note that
this one is also unbatched — acceptable at this size, and say so.

`npx drizzle-kit check` must pass: a schema change without a generated migration is invisible to
lint, tests, and the build (the reason that CI step exists — ADR 0017).

### `src/lib/db/paragraphs.ts` (modify) — the six-round-trip fix

Keep the client sending the full `storySoFar`. **ADR 0007's client-as-truth model stays intact** —
this plan changes how the server *verifies* that array, not who owns it.

- The client's array has a known length and a computable hash. The server compares those two
  scalars against the denormalized `story.paragraphCount` / `story.contentHash` it **already
  fetched** in the story lookup at `route.ts:139`. On a match, the prefix check is satisfied
  without reading any paragraph rows.
- The full read remains, unchanged, for the mismatch path — which is where a genuine divergence
  needs the row-by-row comparison to produce a correct 409.
- Maintain both columns in the **same statements that already write paragraphs**:
  `appendParagraphsOnce` (`:57-61`) and the `insertAIParagraph` CTE (`:73-86`, which already updates
  `story.updatedAt`). They must move together with the insert or the denormalization is a lie.

**The concurrency-safety property must not weaken.** ADRs 0013 and 0016 are explicit that the
`UNIQUE(storyId, position)` index is the only real serialization point and that the read-side check
is "documentation, not enforcement" (`paragraphs.ts:132-134`). The hash check is a faster version
of that same non-enforcing read; the unique constraint still does the actual work. Say this
explicitly in the ADR, and keep every existing race test in `src/test/latch.ts`'s style passing
unmodified — if one needs changing to pass, the concurrency behaviour changed and that is a bug.

Define the hash precisely (algorithm, field order, separator, encoding) in one shared module used by
both client and server. A hash computed two different ways is a permanent 409.

### Feed and library queries

- **Drop the `leftJoin` + `groupBy`** from `src/app/api/feed/route.ts:17-33`,
  `src/app/api/stories/route.ts:60-75`, and `src/app/library/page.tsx:16-30`. Read
  `story.paragraphCount` directly.
- **Keyset pagination for the feed:** `WHERE ("updatedAt", "id") < ($cursor_updatedAt, $cursor_id)
  ORDER BY "updatedAt" DESC, "id" DESC LIMIT 21`. Index `("updatedAt" DESC, "id" DESC) WHERE
  "isShared" = true`. The cursor is opaque to the client and must be validated server-side.
- **Library:** add a `LIMIT` and the same keyset treatment; index
  `story("ownerId", "updatedAt" DESC, "id" DESC)`.
- **Mind the `NULLS` trap.** ADR 0017 documents Drizzle emitting `DESC NULLS LAST` in DDL while
  query-side `desc()` emits `DESC` (`NULLS FIRST`), making the index unusable for ordering. These
  new indexes are multi-column and `DESC` on both — exactly the same trap. Write them with raw
  `sql`, as `schema.ts:96-108` already does, and prove it with an EXPLAIN assertion.
- Replace the four `SELECT *` ownership checks with explicit column lists:
  `generate/route.ts:139`, `stories/[id]/route.ts:15` and `:79`, `report/route.ts:14`. Each
  currently pulls `openingLines` and the `invented` jsonb to check one id.
- `Promise.all` the two serial queries in `src/app/feed/[id]/page.tsx:12-33`.

### `src/lib/db/queries.perf.test.ts` (modify) — make the perf tests honest

EXPLAIN the **actual** shipped queries. The current tests assert an early-stop property against a
`LIMIT 20` stand-in that the real join/groupBy/no-LIMIT queries do not have. Import or mirror the
real query builders so the test cannot drift from the code again — that drift is the defect being
fixed here, not just the queries.

### `src/app/feed/page.tsx` (modify) — server-render page 0

Today this is a client component that fetches page 0 in a mount effect with **no `.catch()`**, and
appends with `setStories(prev => [...prev, ...data.stories])` (`:23-31`) with no in-flight guard —
so a StrictMode double-mount duplicates page 0 into the list.

Convert to an RSC that renders page 0 server-side with a small `"use client"` "load more" island.
That removes the client→API→DB waterfall, fixes the duplicate-append bug structurally, and lets the
page stream. Add a short-TTL Redis cache of page 0 behind `hasKv()`, invalidated when a story's
share state changes in `PATCH /api/stories/[id]`.

**Check `budgets.json` after this** — `/feed`'s budget is 14 100 bytes against a 12 733 baseline.
Moving work to the server should reduce client JS; if it grows, find out why before raising the
budget (ADR 0027's rule: do not raise a number to make a failing build pass).

### `src/lib/db/client.ts` (modify)

`getAuthAdapterDb()` (`:47-49`) deliberately bypasses the memo, so `src/auth.ts:11` constructs a
second Drizzle handle at NextAuth factory time. The bypass exists because the adapter needs a full
`PgDatabase` including `transaction`, which `AppDatabase` omits by design — so keep the separate
*type*, but memoize the *instance*. Preserve the comment explaining why the type differs.

### Cache headers

`Cache-Control` on the read routes (`/api/feed`, `/api/feed/[id]`, `/api/stories`,
`/api/stories/[id]`), which today set none. All of it is per-user and logged-in-only (ADR 0010), so
these must be `private` — a shared cache holding one Writer's library would be a data leak. Be
conservative and explain each choice in the ADR.

## Tests

- `prompt.test.ts` / property tests — the byte-identical-prefix property across turns; chunked
  re-anchoring; the negative-`budgetForRest` clamp; an oversized anchor.
- `pricing.test.ts` — cache-read and cache-write arithmetic; absent cache fields; unknown model.
- `paragraphs.db.test.ts` — hash match skips the paragraph read (assert via the Plan 1 round-trip
  counter, not by inspection); hash mismatch falls back and still produces a correct 409; the
  denormalized columns stay consistent after concurrent turns.
- **Every existing race test must pass unmodified.**
- `queries.perf.test.ts` — EXPLAIN the real feed and library queries; assert no `Sort` node and the
  expected index, including on the new multi-column `DESC` indexes.
- Migration test — backfill produces correct counts and hashes for pre-existing rows.
- E2E — feed pagination across a keyset boundary; the feed page renders without client JS enabled
  for page 0.

## Verification

Full CI reproduction, plus:

- **Prove a real cache hit.** Run two turns on one story against a real provider
  (`npm run eval:live`, or by hand with a key) and confirm a non-zero `cacheReadInputTokens` in
  `generation_event`. **A caching change that never hits is worse than none** — it pays the 125%
  cache-write premium on every request for nothing. If you cannot demonstrate a hit, the plan is
  not done.
- Re-run `npm run bench`. Round trips per saved-story turn should drop from 6 to ~3; record the
  before/after and the cost-per-story delta in the ADR, citing `bench/BASELINE.md`.
- `rm -rf .next && npm run build && npm run bundle-budget`.
- Check the feed and library at ~375px.

## Gotchas

- **Do not change who owns story state.** The client still sends `storySoFar`; only verification
  changes. Trimming the payload is a separate, larger decision that touches ADR 0007 — if it looks
  compelling while working here, flag it rather than doing it.
- A stale `paragraphCount`/`contentHash` produces a permanent false 409 — an unrecoverable story
  from the user's perspective. They must be written in the same statement as the paragraphs, and the
  mismatch path must recover by re-reading rather than hard-failing.
- Neon's HTTP driver has no transactions (`src/lib/db/types.ts:16`, enforced by ESLint and a test).
  Every "same statement" above means literally one SQL statement, usually a CTE.
- Keyset pagination changes the API contract: `nextOffset` becomes an opaque cursor. Update the
  client and the E2E specs together.
- `Cache-Control: public` on any of these routes is a data leak. Use `private`.

## Out of scope

- Semantic or response caching of generations. Two writers with the same prompt **should** get
  different paragraphs; caching model output is wrong for this product. Say so in the ADR — it is
  the obvious-but-wrong answer.
- Summarization instead of truncation for context management (a named v1 scope decision in
  ADR 0005).
- Moving story text out of Postgres.
- Read replicas or multi-region.

## ADRs

**`docs/adr/00NN-stable-prefix-windowing-for-prompt-caching.md`**

- The precise mechanism: the prefix is already stable **under** budget and destabilises **after**
  it, in two ways (sliding window and mutated anchor note). Correct the intuition explicitly.
- Why chunked re-anchoring, and the context-efficiency-for-cache-hit-rate trade, with the price
  ratios that justify it.
- Why a 5-minute ephemeral TTL suits this product's turn cadence.
- Measured hit rate and cost delta.
- Why response caching is wrong here.

**`docs/adr/00NN-denormalized-counters-and-keyset-pagination.md`**

- Why denormalize `paragraphCount`/`contentHash`, and why it does not weaken ADR 0013/0016 — the
  unique index remains the serialization point; the hash check replaces a read that was already
  explicitly non-enforcing.
- Keyset over offset, and the `NULLS` trap repeating from ADR 0017.
- Why the perf tests were testing queries the app does not run, and what stops that recurring.
- Why the feed moved to the server, and why its cache is `private` and short-TTL.
- Consequences: denormalized state can drift, and the mismatch path is the recovery mechanism.
