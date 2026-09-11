# 41. Denormalized counters and keyset pagination

## Status

Accepted.

## Context

Three unrelated-looking inefficiencies turned out to share one root cause: nothing about a story's
shape (how many paragraphs it has, what its content hashes to) was ever stored anywhere except the
`story_paragraph` rows themselves, so every question about that shape meant reading all of them.

- `syncStoryParagraphs` (`src/lib/db/paragraphs.ts`) selected `position`, `authorType`, and the
  **full `text`** of every stored paragraph, on **every** turn, purely to prove the client's array
  is a prefix-extension of what's already saved. A 30-paragraph story reads ~24 KB out of Postgres
  per turn to compare against the ~24 KB the client just uploaded — O(n²) on both the wire and
  Neon's egress meter across a whole story.
- Both the feed and the library `leftJoin story_paragraph` and `groupBy` solely to produce a
  paragraph **count**, aggregating every paragraph row of every matching story before the `LIMIT`
  even applies.
- The library query had **no `LIMIT` at all**, and the feed paged by `OFFSET` with no maximum —
  correctness footguns as much as performance ones (an `OFFSET`-based "page 2" silently skips or
  repeats rows if anything above it changes between requests).

## Decision

### Denormalized `story.paragraphCount` / `story.contentHash`

Both columns are maintained in the **same statements** that already write paragraphs —
`appendParagraphsOnce` and the `insertAIParagraph` CTE — because Neon's HTTP driver has no
transactions, so "same statement" (a single `WITH ... UPDATE` CTE, gated on
`exists(select 1 from ins)`) is the only atomicity available. There is no path where the paragraph
rows land but the counters don't, or vice versa.

**The hash algorithm lives in exactly one place**, `src/lib/story/contentHash.ts`
(`hashStoryParagraphs`), using the Web Crypto API (`crypto.subtle.digest`, SHA-256 over each
paragraph's `author` and `text` — matching precisely what `syncStoryParagraphs`' own row-by-row
prefix check already compares, so the two never disagree about what counts as "the same content").
It's placed in `src/lib/story/`, the app's isomorphic client/server module directory, and written
using only Web-standard APIs so it's usable from either side — but in this implementation, **only
the server calls it**. This is a deliberate deviation from the shape the plan sketched ("a shared
module used by both client and server"): the server already receives the client's complete
`storySoFar` array in the `/api/generate` request body regardless, so it can hash the relevant
prefix itself at effectively zero cost (sub-millisecond SHA-256 over a few KB of text) without
requiring any client-side change. Doing it server-only doesn't just avoid a second call site — it
eliminates rather than merely mitigates the "hash computed two different ways" risk the plan warns
about, since there is only one computation site to begin with. If a future change trims what the
client uploads (out of scope here — see Gotchas below), the client-side half of this module is
already written and ready.

**The fast path** (`tryFastSync` in `paragraphs.ts`): the server compares the client array's known
length and the hash of its first `story.paragraphCount` entries against the denormalized
`story.paragraphCount`/`story.contentHash` it already fetched in the story lookup. On a match, the
prefix property `syncStoryParagraphs` exists to verify is already proven, and the paragraph table
is never read. The full row-by-row read remains, completely unchanged, for every case the fast path
can't resolve:

- `contentHash` is `null` — a story that predates this migration, or one that has never had a
  paragraph written to it yet.
- The computed hash doesn't match — which can mean either genuine divergence (the row-by-row check
  correctly produces the 409) or a merely stale/never-backfilled value (the row-by-row check
  correctly finds no actual divergence and succeeds).
- The fast path's own write loses a concurrency race (a unique-constraint conflict) — it falls
  through to the slow path rather than retrying itself against a `known` snapshot that's now stale;
  the slow path's own retry loop, with a fresh read, is what actually resolves the race.

**This does not weaken the concurrency guarantee ADRs 0013/0016 established.** The
`UNIQUE(storyId, position)` index remains the only real serialization point. The row-by-row
prefix check was already, in ADR 0013's own words, "documentation, not enforcement" — a read two
concurrent requests could both pass, with the unique constraint on the write doing the actual work.
The hash check is a faster version of that same non-enforcing read, not a new enforcement
mechanism; every existing race test in `paragraphs.db.test.ts` passes unmodified (their call sites
grew two new required fields on `insertAIParagraph`, since every caller must now supply the
resulting counter values — but none of their assertions about which write wins, or how a loser
recovers, changed at all). A new test (`keeps paragraphCount and contentHash correct after a
concurrent append race`) extends the existing "recovers by re-reading" race to also assert the
denormalized columns land on the winner's actual content, not some mix of the two attempts.

### `story_report` needed no new index

The plan called for a new index on `story_report(storyId)`, reasoning by analogy with
`generation_event.storyId` (a genuinely unindexed foreign key). But `story_report` already carries
`UNIQUE(storyId, reporterId)`, and a composite index's leading column already serves an
equality lookup on that column alone — a separate `storyId`-only index would be redundant, not
protective. Only `generation_event(storyId)` was actually missing and is added here.

### Keyset pagination, shared query builders

The feed and library queries are extracted into `src/lib/db/feedAndLibrary.ts`
(`getFeedPage`/`getLibraryPage`, and the unawaited `buildFeedQuery`/`buildLibraryQuery` variants
underneath them) and imported everywhere they're needed — the API routes, the RSC pages, and
`queries.perf.test.ts`. Before this, `src/app/api/stories/route.ts` and `src/app/library/page.tsx`
(and likewise the feed's route and page) each carried an independent copy of the same query, which
is exactly how they drifted from what `queries.perf.test.ts` actually asserted against — the defect
ADR 0017 found once already, now structurally prevented by having one function each side imports
rather than two hand-synced copies.

Both queries read `paragraphCount` directly off `story` — no join, no `groupBy`. Both page with a
keyset cursor: `WHERE (updatedAt, id) < (cursor.updatedAt, cursor.id) ORDER BY updatedAt DESC, id
DESC LIMIT 21`, expressed as Drizzle's `or(lt(...), and(eq(...), lt(...)))` since there's no native
row-value comparison. The cursor is opaque to the client — base64url of `updatedAt|id`, validated
only by round-tripping through `decodeCursor`, never parsed for its contents — and a cursor that
fails to decode is a 400, not a guessed page boundary.

**Both composite indexes carry the same trap ADR 0017 already found once.** `story_ownerId_updatedAt_id_index`
and `stories_updated_at_id_is_shared_idx` are declared with raw `sql` `DESC` on every sorted column
(never Drizzle's `.desc()`, which emits `DESC NULLS LAST` — a mismatch against the query side's
plain `desc()`, which means `NULLS FIRST`, that silently defeats the index for ordering). Both
`updatedAt` and the new `id` tiebreaker are declared this way, consistently, so the index's sort
order matches the query's `ORDER BY updatedAt DESC, id DESC` exactly. `queries.perf.test.ts` now
EXPLAINs `buildFeedQuery`/`buildLibraryQuery` directly (via `.toSQL()`, not a hand-written
stand-in) both for the first page and for a second page past a keyset cursor, asserting the index
is used and no `Sort` node appears in either case — the keyset-boundary case is what actually
proves page 2 is as cheap as page 1, not a rescan of everything before it.

### The feed moved to the server

`src/app/feed/page.tsx` was a client component that fetched page 0 in a mount effect with no
`.catch()`, appending via `setStories(prev => [...prev, ...data.stories])` with no in-flight guard
— a React Strict Mode double-mount could duplicate page 0 into the list. It's now an RSC that
renders page 0 server-side, with the paragraph rows and "Load more" button factored into small
presentational (`FeedStoryRow`) and client-island (`FeedLoadMore`) components shared, in shape,
with the equivalent library components. This removes the client→API→DB waterfall for the first
page, fixes the duplicate-append bug structurally (there's no mount effect left to double-fire),
and lets the shell stream. `library/page.tsx` — already server-rendered — got the matching
treatment: it used to render every story a Writer owned with no cap at all, which is now a real
gap once `LIMIT`ed rather than an unbounded query. The plan's "done" summary describes library as
needing only "a LIMIT," but its own implementation section asks for "the same keyset treatment" and
the same three-column composite index the feed gets — an index that would be pointless without
keyset consumption of the `id` column, so library got the full `LoadMore` treatment rather than a
silent, capped, no-way-to-see-older-stories regression.

Page 0 of the feed is additionally Redis-cached (`src/lib/db/feedCache.ts`), gated behind
`hasKv()` exactly like every other Redis-backed mechanism in this app (ADR 0035) — inert, falling
straight through to a real query, when Redis isn't configured. A 30-second TTL is a safety net, not
the primary mechanism: `PATCH /api/stories/[id]` explicitly invalidates the cache whenever a
request's body includes `isShared` (whether or not the value actually flips — cheaper to
over-invalidate an occasional no-op toggle than to fetch-and-compare just to skip a `del`), best-effort
and after the write completes, never gating the response on it.

### `Cache-Control: private, no-store`

`/api/feed`, `/api/feed/[id]`, `/api/stories`, and `/api/stories/[id]` now set
`Cache-Control: private, no-store` on their success responses. `private` alone (allowing a browser
to cache but requiring revalidation) wasn't enough: none of these routes support conditional
requests (no `ETag`/`Last-Modified`), so a browser holding onto a `private` response with nothing to
revalidate against would just serve stale data with no way to detect it. `no-store` says plainly
"never cache this," which is both correct for per-user/logged-in-only data (ADR 0010) and simpler
to reason about than a short `max-age` that would need its own justification for the number chosen.

### `getAuthAdapterDb()` now memoizes its instance

`getAuthAdapterDb()` deliberately returns a differently-*typed* handle than `getDb()`'s memoized
`AppDatabase` — `@auth/drizzle-adapter` needs a full `PgDatabase` (including `transaction`), which
`AppDatabase` omits by design. It previously called `createDb()` fresh on every invocation, so
`src/auth.ts`'s NextAuth factory constructed (and held open, for the life of the process) a second
Drizzle handle distinct from the one every other route uses. The type stays separate — the fix
memoizes the *instance* behind a second module-level variable, so repeated calls return the same
handle instead of a fresh one each time. `client.test.ts`'s existing assertion
(`adapterDb).not.toBe(getDb())`) is unaffected: it was never comparing repeated calls to each other,
only the auth-adapter handle to the app's own narrowed one, which remain — correctly — two distinct
instances.

## Consequences

- **Measured, not the plan's estimated number.** The plan's own text suggested "about three"
  round trips per saved-story turn, down from a baseline of six. Both numbers turned out to be
  stale: `bench/BASELINE.md`'s "six" was measured against commit `d26a41d`, which predates both
  Plan 1 and Plan 2 — this branch (and `main`) already had Plan 2's admission-control and
  spend-governance code merged before Plan 3 began, and that code's own Postgres-fallback paths
  (when Redis isn't configured) add round trips the original six never counted. Measured directly,
  on this branch, before vs. after, with Redis configured (so admission/budget use Redis rather
  than falling back to Postgres, isolating what Plan 3 actually changed): a steady-state saved-story
  turn (turn 1+, not the first/kickoff turn — which never has anything to sync and was already
  cheaper) went from **5 round trips to 4** (`select=2,execute=2,insert=1` → `select=1,execute=2,insert=1`),
  reproducible with `npm run bench -- --writers 5 --turns 5` against a locally built app. That is
  exactly the one read this record removes — the sync-prefix select — and nothing more, which is
  the correct scope: `appendParagraphsOnce` and `insertAIParagraph` cannot be merged into a single
  statement regardless of the hash check, because the AI's paragraph text doesn't exist until after
  the provider call completes, strictly after the Writer's paragraph is already persisted. Getting
  to "three" would require touching Plan 2's rate-limit/budget round trips or the
  `generation_event` write, both explicitly out of this plan's scope.
- A stale or never-backfilled `contentHash` can never produce a false success or a false 409 by
  itself — it can only cause an unnecessary fall-back to the always-correct slow path, which is a
  cost (one extra read), never a correctness risk. This is why the migration is allowed to leave
  `contentHash` `null` for every pre-existing row (see the migration's own comment) rather than
  attempting to backfill a hash value: a wrong backfilled hash would cost the same one-time
  fallback read as a `null` one, but computing it would mean a second, raw-SQL implementation of
  the hash algorithm — exactly the divergent-implementation risk this whole design goes out of its
  way to avoid elsewhere.
- Keyset pagination changes the API contract for both `/api/feed` and `/api/stories`:
  `nextOffset` (a plain integer) becomes `nextCursor` (an opaque string). No shipped client
  consumed `GET /api/stories`'s pagination before this change (the library page queried the
  database directly, duplicating the query rather than calling its own API route) — only the
  feed's client actually needed updating, and it's been rewritten as part of the RSC conversion
  above rather than patched to speak the old contract.
- `rows.length === 0` still means "nothing to paginate" for both `FeedLoadMore` and
  `LibraryLoadMore` — a page that comes back with zero rows always also carries a `null`
  `nextCursor` (`toPage`'s own logic in `feedAndLibrary.ts` only computes a cursor from the last
  row of a non-empty page), so the empty-state message and the "Load more" button can never both
  render at once.

## Out of scope

- Trimming what the client uploads (sending a hash instead of the full `storySoFar`). ADR 0007's
  client-as-truth model is unchanged by this record — only how the server *verifies* the array
  changed, never who owns it or what it sends. This would be a separate, larger decision.
- Read replicas, multi-region, or any change to where story text lives (still Postgres, still one
  region — unchanged from ADR 0009).
