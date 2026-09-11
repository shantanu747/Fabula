# 34. Capacity benchmark harness

## Status

Accepted.

## Context

Plans 2 and 3 (`docs/plans/v4/02-admission-control.md`, `03-caching-and-data-model.md`)
both claim to make the application cheaper and faster. Nothing in the repo measured
throughput, latency under concurrency, database round trips, or dollars per story, so
neither claim could be made honestly. `vitest.perf.config.mts` asserts query *plans*
(no `Sort` node, the right index is chosen) — a deliberately different thing from a timing
test. `evals/` measures output quality, not cost or latency. ADR 0022 records TTFT and
cost into `generation_event` on every generation and nothing had ever read it back.

Spec: `docs/plans/v4/01-load-harness.md`.

## Decision

**A bespoke `tsx` script, not k6/artillery.** Both are separate binaries outside the npm
dependency tree, and neither can drive the mock provider's remote-control plane, read
`generation_event` back, or reuse `e2e/constants.ts` and `test-support/mock-provider`. The
harness needed exactly those three things, all already in-repo.

**Not a CI job.** A latency threshold on shared CI runners flakes (ADR 0020/0021's whole
saga is about exactly this class of problem for the E2E suite's timeouts), and a flaky gate
gets ignored — worse than no gate. This is a tool run deliberately before and after a
performance change, with `bench/BASELINE.md` as the committed artifact plans 2 and 3
diff against. `bench/report.test.ts` still runs in CI (`npm run test:scripts`), but that
only covers the pure percentile arithmetic, not the harness's live run.

**All virtual writers share one authenticated identity.** This is the single most
consequential, least obvious decision in this plan, so it's worth stating why explicitly
rather than leaving it implicit in the code. `guardGenerate` (`src/lib/ratelimit/guard.ts`)
keys `GENERATE_USER`'s token bucket by `userId`. Registering N distinct accounts — the
"obvious" choice for "N independent writers" — would give each its own 20-request bucket,
and the plan's own default (`--writers 10 --turns 10`, 100 calls total) would then sail
under every limit without ever exercising one, silently defeating the plan's own stated
gotcha ("the rate limiter will fire... that is a real finding"). One shared identity means
every call in a run competes for the *same* bucket, which is what actually reproduces the
cited numbers (capacity 20, refill 1/15s) and is why the default run 429s roughly 80% of
its calls — a real, reproducible finding about today's system, not a harness artifact. The
guest path's parallel trap (`clientIp()` falling back to `"unknown"`, ADR 0019) is a
second, separate way multiple callers can collapse onto one bucket; this harness doesn't
exercise it because the six-round-trip metric it exists to measure only applies to the
persisted (`storyId`-bearing) path, which requires authentication regardless.

**Round trips are counted with a Proxy, not by reading source or parsing Postgres logs.**
`bench/roundtrips.ts` wraps `AppDatabase` and increments a counter, tagged by which of
Drizzle's four statement-issuing methods (`select`/`insert`/`update`/`execute`) was
*called* — not merely accessed as a property, which an earlier version of this file got
wrong (see Consequences) and which `bench/roundtrips.db.test.ts` now asserts against
directly. This observes the actual boundary the app crosses, following the same technique
`src/test/latch.ts` established for ADR 0014's deterministic race tests. Verified
mechanically against real turns (see `bench/BASELINE.md`): a saved-story turn is 6 round
trips once a Writer paragraph exists to sync, and 5 for the very first (empty-`storySoFar`)
turn of a story, where `syncStoryParagraphs` has nothing to append and skips its insert —
a distinction the plan's own framing didn't call out, and exactly the kind of thing "count
it, don't read the source" was supposed to catch.

**The counter is exposed through a dev-only route, gated on an env var, wired into
`getDb()` rather than `createDb()`.** `src/lib/db/client.ts`'s `getDb()` wraps the database
singleton with the counter only when `BENCH_INSTRUMENTATION=1` — never set outside a
harness run. This has to live in `getDb()`, not the shared `createDb()` helper both `getDb()`
and `getAuthAdapterDb()` call: wrapping in `createDb()` widens its inferred return type to
include the narrowed `AppDatabase` (which omits `transaction`/`batch`, ADR 0014), which then
fails to satisfy `DrizzleAdapter`'s `SqlFlavorOptions` in `src/auth.ts` — caught by
`npm run typecheck`, not by inspection. `GET /api/__bench/roundtrips` (which reads and resets
the counter) 404s unconditionally unless that same env var is set, asserted in
`route.test.ts`, so the route is behaviorally indistinguishable from absent in a normal
build or deployment.

**That route's directory is `src/app/api/%5F%5Fbench/`, not `__bench/`.** Next.js's App
Router treats any folder prefixed with a literal underscore as a private, non-routable
folder (`docs/01-app/01-getting-started/02-project-structure.md` in this repo's own
`node_modules/next/dist/docs/`) — a plain `__bench/roundtrips/route.ts` compiles cleanly,
is absent from `next build`'s route table, and 404s unconditionally regardless of the env
var, silently. `%5F` is Next's documented escape hatch for a URL segment that must start
with an underscore on the wire; the folder name is the encoded form, the route itself is
still exactly `/api/__bench/roundtrips`. Worth naming here because it's the kind of thing
that looks like it works (the file exists, the code typechecks) right up until the first
request to it 404s and the natural next guess (env var not set, typo, build cache) is
wrong.

**Round-trip counting and concurrent-workload measurement are two separate phases,
never overlapping.** The counter is process-wide (one Next.js server process backs every
concurrent request), so reading and resetting it *during* the concurrent `--writers`
workload would attribute one request's round trips to a different, overlapping request.
Phase A runs strictly before Phase B: one story, up to 3 sequential turns, reset-call-read
around each. Phase B then runs the actual concurrency workload without touching the
counter at all. This is why "database round trips" and "TTFT under concurrency" are
reported from two different parts of the same run rather than derived from one combined
pass.

**The harness owns its own Postgres lifecycle rather than reusing
`e2e/global-setup.ts`.** It duplicates roughly 15 lines (drop/create/migrate `fabula_e2e`,
bootstrap the Neon proxy's `neon_control_plane` table) instead of importing that file's
`createAndMigrateDatabase`. `e2e/global-setup.ts` is load-bearing for the CI `e2e` job and
owns a Playwright-specific lifecycle (a `globalThis` handoff to `global-teardown.ts`); this
harness has a simpler one (one process, no separate teardown phase), and duplicating a
small amount of setup SQL here was judged lower-risk than threading a load-testing tool's
needs through the E2E suite's shared infrastructure. `e2e/helpers/db.ts`'s `resetDatabase()`
*is* reused as-is (truncation has no such lifecycle coupling). One consequence: the harness
and the E2E suite target the same local Postgres, proxy, and mock-provider port, and must
not run concurrently — each drops and recreates `fabula_e2e` on startup.

**The app port is bench-specific (3112), the database and proxy are not.** `e2e/constants.ts`'s
`DATABASE_URL`, `NEON_FETCH_ENDPOINT`, `NEON_PROXY_HOST`, and `MOCK_PROVIDER_PORT` are
reused verbatim rather than duplicated, per the plan. `APP_PORT` (3111) is deliberately
not reused: that port is Playwright's, and this repo has already relearned once that
running a second dev server on it causes confusing collisions. The harness's own app
process runs on 3112 instead.

## Consequences

- `npm run bench -- --writers 10 --turns 10` against the mock provider takes under a
  minute per run (dominated by `next build`) and requires nothing beyond what E2E already
  needs locally (Postgres, the Neon proxy).
- `bench/BASELINE.md` records three consistent runs (p95 TTFT within ~9% of each other)
  and one clear outlier (p95 TTFT 65s, later shown non-reproducing) — reported rather
  than discarded, per the plan's explicit instruction not to pick the flattering run.
- Writing `bench/roundtrips.ts` found a real bug before it shipped: the first version
  incremented the counter in the Proxy's `get` trap, which fires on property *access*
  (`db.select`) rather than *invocation* — over-counting if a method reference were ever
  handed off without being called. `bench/roundtrips.db.test.ts`'s "does not count
  uncounted properties" case exists specifically to pin this down against a real
  `AppDatabase`, not a stub that would happily agree with either implementation.
- Plans 2 and 3 now have a concrete "before": 6 round trips per steady-state saved turn (5
  on a story's first turn), ~80% of calls 429ing at the default 10-writer/10-turn/shared-
  identity workload, and a read-back cost/token pipeline proven to work end to end. Both
  plans re-run this harness and record their deltas in their own ADRs against this
  baseline.
- The harness is local-only tooling: it is not part of `.github/workflows/ci.yml`, and
  `bench/results/` (raw per-run JSON) is gitignored — only `BASELINE.md` is committed.

## Rejected

- **k6 or artillery** — see Decision above.
- **Distinct accounts per virtual writer** — see Decision above; it would under-measure
  the exact thing the harness's own default workload is designed to surface.
- **Reusing `e2e/global-setup.ts`'s database bootstrap directly** — see Decision above;
  judged higher-risk than a small amount of duplication given that file's CI-load-bearing
  Playwright lifecycle.
- **Wrapping the database in `createDb()`** — breaks `src/auth.ts`'s `DrizzleAdapter` typing;
  see Decision above.
