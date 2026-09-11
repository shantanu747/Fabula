# Plan 1 — Capacity benchmark harness

**Branch:** `feature/load-harness`
**Depends on:** nothing. **Lands first.**
**ADR:** required (next unused number, expected `0030`).

## Why this exists

Plans 2 and 3 both claim to make the application cheaper and faster. Neither claim can be made
honestly right now, because nothing in this repo measures throughput, latency under concurrency,
database round trips, or dollars per story.

What exists is adjacent but not this:

- `vitest.perf.config.mts` / `src/lib/db/queries.perf.test.ts` assert **query plans** (no `Sort`
  node, the expected index is chosen). That is the right way to test an index and deliberately not
  a timing test — but it tells you nothing about behaviour under load.
- `evals/` measures **output quality**, not cost or latency.
- ADR 0022 records TTFT per request into `generation_event`, but nothing aggregates it.

The specific numbers this harness must produce, because later plans are judged against them:

1. **Database round trips per operation.** Reading the source says a saved-story turn is six
   sequential `neon-http` round trips (rate-limit upsert → `select * from story` →
   `syncStoryParagraphs`' full-paragraph read → writer insert → AI-paragraph CTE →
   `insertGenerationEvent`). Plan 3 claims to cut that to about three. Counting it must be
   mechanical, not a reading of the code.
2. **TTFT percentiles under concurrency** — the metric the entire streaming architecture (ADR 0003)
   exists to optimise, never once measured under more than one caller.
3. **Cost and token counts per story**, read back from `generation_event` — the table ADR 0022
   added for exactly this and which nothing has ever queried.

## What "done" means

- `npm run bench` runs a scripted multi-writer workload against a locally built app, a real
  Postgres behind the Neon HTTP proxy, and the existing mock provider, and prints a table.
- Round-trip counts are **observed**, not asserted from reading source.
- `bench/BASELINE.md` is committed with the measured numbers and the exact command that produced
  them.
- The harness is not a CI job, and the ADR says why.

## Files

### `bench/harness.ts` (new)

A bespoke TypeScript harness run through `tsx`. **Do not add k6 or artillery**: both are separate
binaries outside the npm dependency tree, and neither can drive this app's mock-provider remote
control plane or read `generation_event` back. The pieces needed already exist in-repo.

Reuse, do not rebuild:

- `test-support/mock-provider/server.ts` — `startMockProvider({ port, remoteControl: true })`.
  Deterministic token timing via `streamResponse(chunks, { delayMs })`, so measured TTFT is the
  app's overhead plus a known constant rather than provider noise.
- `e2e/constants.ts` — `NEON_PROXY_HOST`, `DATABASE_URL`, `NEON_FETCH_ENDPOINT`,
  `MOCK_PROVIDER_PORT`. Do not duplicate these literals; that file exists to stop exactly that.
- `e2e/helpers/db.ts` — database creation/truncation between runs.
- `src/lib/db/client.ts` — `getDb()` for the read-back queries.

Workload model:

- `--writers N` virtual writers, each running an independent story: create → alternate Writer
  paragraph / AI generation for `--turns T` turns.
- `--turns T` (default 10, enough that the context window and the growing per-turn read are both
  visible).
- Writers start staggered over a short ramp so the measurement is of steady state, not a
  thundering herd at t=0. Report the ramp in the output.
- `--live` swaps the mock for real providers. Off by default; it spends money. Guard it so it
  cannot run without an explicit confirmation flag.

Metrics per run:

| Metric | How |
|---|---|
| TTFT p50 / p95 / p99 | time from `fetch` initiation to the first body byte |
| Turn duration p50 / p95 / p99 | to stream completion |
| Throughput | completed turns per second at steady state |
| Error rate by status | count 429 / 502 / 409 separately — a 429 is a *result*, not a failure, and lumping them together is how a benchmark lies |
| DB round trips per operation | see below |
| Bytes uploaded per turn | `storySoFar` payload size, which grows with story length |
| Tokens + cost per story | `SELECT` over `generation_event` after the run |

### `bench/roundtrips.ts` (new) — the counting `Proxy`

A `Proxy` over `AppDatabase` that increments a counter on each `select` / `execute` / `insert` /
`update` call and tags it with a caller-supplied label.

This technique is already established in the repo: `src/test/latch.ts` wraps the database in a
Proxy to make concurrency races deterministic (ADR 0014). Follow that file's shape. Plan 7 later
turns the same wrapper into a tracing Proxy for DB spans — write it so that is a small extension,
not a rewrite.

The counter runs in the app's process, so the harness needs the count out. Simplest approach that
does not alter production code paths: a dev-only route (`/api/__bench/roundtrips`) mounted **only**
when `BENCH_INSTRUMENTATION=1`, returning and resetting the counters. It must be impossible to
reach in a normal build — assert that in a test, and state the reasoning in the ADR.

### `bench/report.ts` (new)

Percentiles, the summary table, and JSON output. **This file holds the only logic worth unit
testing**, so keep it pure: no I/O, no timers. Percentile arithmetic (interpolation, single-sample,
empty input, unsorted input) is exactly the kind of thing that is quietly wrong for months.

### `bench/BASELINE.md` (new, committed)

The measured `main` baseline: date, commit SHA, hardware, exact command, and the table. Plans 2 and
3 re-run the harness and record their deltas in their own ADRs against this file.

### `package.json`

```json
"bench": "node --env-file-if-exists=.env.local ./node_modules/.bin/tsx bench/harness.ts"
```

Matches the existing `eval:record` / `eval:live` invocation style.

### `vitest.scripts.config.mts`

Add `bench/**/*.test.ts` so `bench/report.test.ts` runs in the existing `npm run test:scripts` job
(already part of CI's `quality` job). The harness itself is not tested by it.

### `.gitignore`

Add `bench/results/`. Run artifacts are regenerated; only `BASELINE.md` is committed. Follow the
comment style used for the existing `evals/report.json` entry.

## Tests

- `bench/report.test.ts` — percentiles against hand-computed values; empty input; one sample;
  unsorted input; p99 with fewer than 100 samples (the case that silently returns the max).
- `bench/roundtrips.test.ts` — the Proxy counts each call shape once and does not swallow errors or
  change return values. Assert against a real `AppDatabase` from the `db` Vitest project, not a
  stub, so it cannot pass against a mock that does not resemble Drizzle.
- A test asserting the `/api/__bench/` route is absent without `BENCH_INSTRUMENTATION=1`.

## Verification

```bash
docker run -d --name fabula-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:17-alpine
# plus the Neon HTTP proxy from README's "Developing against a local database"
npm run bench -- --writers 10 --turns 10
```

Run it **at least three times** and report the spread, not one number. A single run of a latency
benchmark on a laptop is not a measurement. If p95 varies more than ~20% run to run, say so in
`BASELINE.md` rather than picking the flattering run — later plans compare against this, so an
optimistic baseline makes a real improvement look like a regression.

Then the full CI reproduction from the README.

## Gotchas

- **The mock provider's `delayMs` is per chunk.** ADR 0026 is a case study in an E2E assertion that
  depended on a chunk-timing margin that was too tight. Pick a delay that makes TTFT measurable
  above scheduler noise and state the value in the output header.
- **The rate limiter will fire.** Ten writers at speed will exceed `GENERATE_USER` (capacity 20,
  refill 1/15s). That is a real finding and the harness must report 429s as their own category
  rather than crashing or silently retrying. Do **not** raise the limits to get a clean run — the
  bound is the thing being measured. Plan 2 changes these numbers deliberately; this plan records
  what they are today.
- **`clientIp()` falls back to the literal string `"unknown"`** when no `x-forwarded-for` is
  present, so every guest writer collapses onto one bucket row (the trap already documented for the
  E2E suite in ADR 0019). Either set a distinct `x-forwarded-for` per virtual writer, or run
  authenticated writers. Document which, because it changes what the numbers mean.
- **`next build` before benchmarking, never `next dev`.** Dev-mode compilation would dominate the
  measurement.
- Neon's HTTP endpoint and the local proxy have different latency characteristics. The round-trip
  *count* transfers to production; the absolute millisecond figures do not. Say so in `BASELINE.md`.

## Out of scope

- Making anything faster. This plan only measures. Resist every fix it reveals — they are plans 2
  and 3, and fixing them here destroys the baseline.
- Adding the harness to CI.
- Profiling the React client, bundle size (`npm run bundle-budget` covers it), or eval quality.

## ADR

`docs/adr/00NN-capacity-benchmark-harness.md`. Cover:

- Why a bespoke harness rather than k6/artillery: no new binary, reuses the mock provider's
  remote-control plane and `e2e/constants.ts`, and needs to read `generation_event` back — none of
  which an external load tool can do.
- Why it is **not** a CI gate: a latency threshold on shared CI runners flakes, and a flaky gate
  gets ignored, which is worse than no gate. It is a tool run deliberately before and after a
  performance change, and `BASELINE.md` is the artifact.
- Why round trips are counted with a Proxy rather than by reading the source or by parsing
  Postgres logs: the Proxy observes the driver boundary the application actually crosses, and
  ADR 0014 already established the technique here.
- The dev-only instrumentation route, and what stops it existing in a production build.
- What the numbers do and do not transfer to production (count yes, absolute latency no).
