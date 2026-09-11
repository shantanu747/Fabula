# Capacity benchmark baseline — `main`

Measured against commit [`d26a41d`](../../commit/d26a41d1536e130ff8632b5f15d98bb587654166)
(the tip of `main` this plan branched from), before any of v4's changes.

- **Date:** 2026-09-11
- **Hardware:** Apple M3 Pro, 12 cores (6P+6E), 18GB RAM, macOS 26.6.2
- **Command:** `npm run bench -- --writers 10 --turns 10`
- **Local services:** Postgres 17 (`postgres:17-alpine` in Docker) and
  `ghcr.io/timowilhelm/local-neon-http-proxy:main` in front of it, per README's
  "Developing against a local database". The mock provider (chunk delay 15ms —
  chosen because it puts real elapsed time above scheduler noise without making a
  10-turn run slow to iterate on).

## What this run actually measures

Every virtual writer signs in as the **same** authenticated account (see docs/adr/0034)
rather than getting one account each. That's deliberate, not a shortcut: `guardGenerate`
(`src/lib/ratelimit/guard.ts`) keys `GENERATE_USER`'s bucket by `userId`, so N distinct
accounts would each get their own 20-request bucket and the default `--writers 10 --turns
10` (100 calls total) would sail under the limit without ever exercising it. One shared
identity means all 100 calls compete for **one** bucket — capacity 20, refill 1/15s
(`src/lib/ratelimit/policy.ts`) — which is what actually happens today at this workload
size, and is the finding below.

Each run does two phases:

- **Phase A** — sequential, one `/api/generate` call at a time, resetting the dev-only
  `/api/__bench/roundtrips` counter immediately before and after each call. This is the
  "database round trips per operation" number: mechanical, not read from source.
- **Phase B** — the concurrent `--writers`/`--turns` workload, ramped over 2 seconds (10
  writers × 200ms stagger), that produces the TTFT/throughput/error/cost numbers.

## Results

Three consecutive full `next build` + `next start` runs (not `next dev` — see the plan's
gotcha about dev-mode compilation dominating the measurement) at the default workload:

| Run | TTFT p50 / p95 / p99 | Turn duration p50 / p95 / p99 (successes only) | Throughput | Calls (success / 429) |
|---|---|---|---|---|
| 1 | 452 / 566 / 588 ms | 844 / 992 / 1013 ms | 3.35/s | 17 / 83 |
| 2 | 409 / 585 / 599 ms | 814 / 1001 / 1018 ms | 3.46/s | 18 / 82 |
| 3 | 424 / 619 / 644 ms | 828 / 1047 / 1082 ms | 3.33/s | 17 / 83 |

p95 TTFT varies by about 9% across these three (566→619ms) — comfortably inside the ~20%
threshold the plan sets for "trust the spread, not one number." **A fourth run, not shown
in the table, is worth naming rather than discarding**: it recorded p95 TTFT of 65.2s and
p99 of 68.8s (throughput 0.30/s), traced to exactly 3 of the 100 requests individually
stalling ~69s before their first byte, with every other request in that same run
finishing normally (400–650ms, the same range as the table above). Re-running
immediately afterward with no other change reproduced the normal numbers. The evidence
points at a transient host-level stall (something froze this dev machine's event loop or
scheduling for ~69 seconds, since 69s corresponds to no application timeout constant —
`FIRST_CHUNK_TIMEOUT_MS` is 20s, `STREAM_IDLE_TIMEOUT_MS` is 30s, and neither nor their sum
is 69s) rather than a real capacity ceiling in the app. Recorded here instead of quietly
re-rolled, per the plan's instruction not to pick the flattering run — but not folded into
the headline numbers either, since three repeats of the same anomaly would be needed to
call it a property of the system rather than of this laptop on that particular minute.

### Database round trips per operation (Phase A, mechanical count)

| Turn | Total | select | insert | update | execute |
|---|---|---|---|---|---|
| 0 (zero-input kickoff, empty `storySoFar`) | **5** | 2 | 1 | 0 | 2 |
| 1 (Writer paragraph present) | **6** | 2 | 1 | 0 | 3 |
| 2 (Writer paragraph present) | **6** | 2 | 1 | 0 | 3 |

Confirms the plan's claimed 6 round trips for a saved-story turn — **with one caveat the
plan's own framing glossed over**: the very first turn of a story (empty `storySoFar`,
nothing for `syncStoryParagraphs` to append) is actually 5, not 6.
`syncStoryParagraphs` (`src/lib/db/paragraphs.ts`) short-circuits its insert when
`toAppend.length === 0`, which is exactly the zero-input-kickoff case — there's no Writer
paragraph yet to persist. Turn 1 onward, once a Writer paragraph exists to sync, is where
the steady-state 6 shows up. Plan 3's "cut it to about three" claim should be measured
against the steady-state 6, not the kickoff's 5.

Breakdown by call shape, mapped to source:

- `execute` ×1 — the rate-limit token-bucket upsert (`src/lib/ratelimit/store.ts`)
- `select` ×1 — the story ownership check (`src/app/api/generate/route.ts`)
- `select` ×1 — `syncStoryParagraphs`' read of stored paragraphs
- `execute` ×1 (turns 1+ only) — `syncStoryParagraphs`' append insert (raw SQL)
- `execute` ×1 — the AI-paragraph CTE insert+update (`insertAIParagraph`)
- `insert` ×1 — `insertGenerationEvent`

### Cost and tokens (read back from `generation_event`, not asserted)

Representative run: 11 stories (10 writers + Phase A's own), 20 `generation_event` rows,
200 input tokens, 900 output tokens, $0.0094 total — all against the mock provider's fixed
8-chunk response, so the token/cost figures reflect the mock's fixed output size, not a
real model's. This column exists to prove the read-back path works (ADR 0022's
`generation_event` table, queried for the first time by anything in this repo), not to
say anything about real-provider economics; a `--live` run against real providers would
give the actual number, at actual cost, which is why `--live` requires
`--confirm-live-spend`.

## What transfers to production and what doesn't

- **Round-trip counts transfer.** They're a property of the code path, not the network —
  the same six statements execute against Neon's real HTTP endpoint in production.
- **Absolute millisecond figures do not.** Local Postgres behind a local Neon HTTP proxy
  has different latency characteristics than Neon's actual managed HTTP endpoint (different
  network path, no cold connection pooling behavior, no multi-tenant contention). Use these
  numbers to compare *before vs. after* a change measured the same way, not as a production
  SLO.
- **The GENERATE_USER-capacity-exceeded finding is real and will recur in production**
  under the same shape of load (many concurrent turns from one account, or — separately —
  many guests behind one NAT/proxy IP, per `clientIp()`'s "unknown" fallback), independent
  of which Postgres this ran against. This is the gap Plan 2 (admission control) exists to
  close.

## Reproducing

```bash
docker run -d --name fabula-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:17-alpine
docker run -d --name fabula-e2e-neon-proxy -p 4444:4444 \
  -e PG_CONNECTION_STRING="postgres://postgres:postgres@host.docker.internal:5432/fabula_e2e" \
  ghcr.io/timowilhelm/local-neon-http-proxy:main
npm run bench -- --writers 10 --turns 10
```

The harness creates and migrates `fabula_e2e` itself (dropping and recreating it each
run) and truncates before starting — do not run this against a database you care about,
and do not run it at the same time as `npm run test:e2e` (both target the same local
Postgres, proxy, and mock-provider port by design; see docs/adr/0034).
