# Plan 2 — Admission control, spend governance, and the Redis tier

**Branch:** `feature/admission-control`
**Depends on:** Plan 1, for the before/after numbers. *If Plan 1 isn't merged yet:* the work is
still correct without it, but the ADR must not claim a measured improvement — say "unmeasured" and
add the numbers in a follow-up rather than estimating.
**ADRs:** two — the Redis tier, and admission control + spend governance.

## Why this exists

Three separate holes, all of the same shape: nothing bounds what one caller can consume.

1. **There is no concurrency limit anywhere.** `grep -rniE "semaphore|p-limit|inflight|concurren"
   src/` returns comments only. The token bucket in `src/lib/ratelimit/` is a *rate* limit — it
   bounds requests per unit time, not requests in flight. `GENERATE_USER` (capacity 20) lets one
   account open twenty simultaneous streams against a single shared provider key, and N distinct
   IPs have no ceiling at all. With one API key per provider (`registry.ts:19-23`), one user can
   consume the whole org's provider quota and everyone else gets 502s.
2. **There is no spend limit.** `generation_event.costUsd` has been written since ADR 0022 and
   **nothing has ever read it back**. There is no per-user cap, no global cap, no circuit breaker,
   and no alert.
3. **Most routes have no rate limit at all.** Only `/api/generate`, `/api/health`, and
   `/api/auth/register` are guarded. `/api/stories` (GET and POST), `/api/stories/[id]` (GET and
   PATCH), `/api/feed`, `/api/feed/[id]`, and `/api/stories/[id]/report` all reach Postgres
   unguarded.

Plus two known defects in the limiter that already exists:

- **`clientIp()` (`src/lib/ratelimit/policy.ts:79-86`) trusts the leftmost `x-forwarded-for`
  entry.** That file's own comment (`:71-78`) admits the consequence: behind a proxy that appends
  rather than rewrites, "a caller can spoof the left entry and mint themselves fresh buckets." The
  guest generate limit is therefore bypassable today.
- **`rate_limit_bucket` is never pruned** — named explicitly in ADR 0015 ("nothing prunes them… a
  periodic delete of rows untouched for a day is the obvious follow-up").

## What "done" means

- A user cannot hold more than a configured number of generations in flight, and the global count
  is bounded regardless of how many distinct callers there are.
- Daily spend is bounded per user and globally, enforced from real recorded cost.
- Every route that touches Postgres has a rate-limit policy.
- Redis being absent, slow, or erroring **never** breaks the app: it degrades to the existing
  Postgres limiter.
- A spoofed `x-forwarded-for` cannot mint a fresh bucket.
- `rate_limit_bucket` has a pruning path.

## Files

### `src/lib/kv/client.ts` (new)

`@upstash/redis` — REST-based, so there is no TCP connection pool to manage on serverless and it
works in the Edge runtime (where `proxy.ts` runs). This is the same reasoning that put `neon-http`
in `src/lib/db/client.ts`.

Mirror that file's shape exactly: a module-level memoized handle, a `hasKv()` predicate, an
injection point for tests, and an env override so local/CI can point at
`serverless-redis-http`. Configuration is `KV_REST_API_URL` + `KV_REST_API_TOKEN` (the names
Vercel KV and Upstash both use, so no adapter is needed later).

**The rule that governs this entire plan, and the subject of its first ADR: Redis is never
authoritative.** It is a performance and coordination tier over a Postgres source of truth. This
is the same posture the app already takes with client state versus the database (ADR 0007/0009),
applied one layer down. Concretely:

- Every Redis operation has a defined behaviour when Redis is missing or throws, decided
  per-operation and never by accident.
- Rate limiting **falls back to the existing Postgres token bucket** — which is already written,
  already tested, and held at 100% coverage. Do not delete it.
- Admission control **fails open to the Postgres limiter**. A Redis outage must not stop people
  writing stories. Bounding concurrency is a cost optimisation; writing is the product.
- Spend governance **fails closed at the global cap** and open per user: without Redis, fall back
  to a direct `generation_event` aggregate, and if *that* fails, allow the request and log loudly.
  Reconciliation catches the drift; a hard outage denying every user is worse than a few dollars.

Wrap every call in a timeout (a few hundred ms). A hung Redis must not add latency in front of
TTFT — that would make the cost optimisation a latency regression.

### `src/lib/ratelimit/store.ts` (modify)

Add a Redis strategy **behind the unchanged public interface**. Callers in `guard.ts` must not
learn which backend answered.

The Redis bucket is one atomic Lua script (read tokens + last-refill, refill by elapsed time, cap
at capacity, decrement if ≥1, write back, return the result) — the direct translation of the
existing single-statement SQL upsert at `store.ts:45-53`, and atomic for the same reason: the whole
read-modify-write happens in one place that cannot interleave.

This removes one Postgres write from every limited request, which also removes one dead tuple per
request from a single-row-per-caller table.

`src/lib/ratelimit/**` is held at **100% coverage**. Both backends and every fallback branch need
tests.

### `src/lib/ratelimit/policy.ts` (modify)

**Fix `clientIp()`.** Add `TRUSTED_PROXY_HOP_COUNT` (default 1) and take the Nth entry **from the
right** of `x-forwarded-for`, since only the rightmost entries are written by infrastructure you
control. Document the Vercel case (`x-vercel-forwarded-for`, single trusted hop) in the ADR.

Handle the no-header case deliberately instead of collapsing every caller onto the literal
`"unknown"` bucket, which today makes one shared row for all of them: fall back to a
per-browser-session identifier, and apply a much stricter global guest ceiling so an unidentifiable
population is bounded in aggregate.

New policies for the unguarded routes. Reads are cheap and can be generous; writes are not:

| Policy | Scope | Shape |
|---|---|---|
| `STORIES_READ` | `/api/stories` GET, `/api/stories/[id]` GET | generous, per user |
| `STORIES_WRITE` | `/api/stories` POST, `/api/stories/[id]` PATCH | modest, per user |
| `FEED_READ` | `/api/feed`, `/api/feed/[id]` | generous, per user |
| `REPORT` | `/api/stories/[id]/report` | strict — this one writes a row per call |

Pick concrete numbers from what a real co-writing session does (the Plan 1 harness shows you), and
put the reasoning in a comment next to each, matching the style of the existing policies.

### `src/lib/admission/lease.ts` (new)

Per-user and global in-flight generation caps.

- Acquire: `INCR` a counter keyed by user (or guest bucket), plus a global counter. Over the cap →
  release and refuse.
- **Every lease has a TTL.** A crashed isolate must not leak a slot forever — without a TTL, one
  crash permanently reduces capacity and the only fix is a manual Redis edit. The TTL is the
  maximum plausible generation duration plus margin.
- Release is idempotent.

Refusal is `429` with `kind: "at-capacity"` and a `Retry-After`, distinct from a rate-limit 429 so
the client can say something accurate ("you have another paragraph generating") rather than "slow
down".

**The hard part — and the thing to test first.** The lease must be released on every terminal path,
including the ones that are easy to miss. `src/app/api/generate/route.ts` already solved this exact
problem for span lifetime: ADR 0022 documents five end points, guarded by the `finishedOnce` latch
at `route.ts:372-378`. **Release the lease inside that same latch.** Do not add a parallel
lifetime-management mechanism — one latch, both resources. A leaked lease is worse than no
admission control, because capacity silently decays until the app refuses everyone.

Test it the way span count is tested today: an in-memory KV, and an assertion that acquisitions
minus releases is exactly zero after success, pre-stream provider error, mid-stream error, client
disconnect before first chunk, and client disconnect mid-stream.

### `src/lib/budget/` (new)

Daily spend caps.

- On completion, `INCRBYFLOAT` a per-user daily key and a global daily key with the
  `estimateCostUsd` value already computed at `route.ts:191-194`. Expire the keys, do not sweep
  them.
- On admission, read both and refuse if either is exceeded.
- **Reconcile from `generation_event`, which is the source of truth** — the Redis counters are an
  accelerator. On a cold key, or periodically, recompute from
  `SELECT sum("costUsd") FROM generation_event WHERE "userId" = $1 AND "createdAt" >= $2`. This
  needs a composite index: `generation_event(userId, createdAt DESC)`. The existing single-column
  `generation_event_userId_index` cannot serve the range efficiently.
- Guests share **one global guest budget**, since guest identity is inherently weak. This is the
  honest bound on guest cost abuse and should be stated plainly in the ADR.
- Refusal is a distinct `kind` with a clear, non-alarming message. A parent co-writing with a kid
  should see "Fabula has hit today's limit — try again tomorrow", not an error code.
- `estimateCostUsd` returns `undefined` for an unknown model (`pricing.ts:44`, deliberately not
  zero). An unpriced generation must **not** count as free — count it at a configured conservative
  default and log, or the way to bypass the budget is to use an unpriced model.

### `src/app/api/generate/route.ts` (modify)

Order matters, cheapest rejection first: rate limit (existing, `:123`) → admission lease → budget
check → provider call. Acquire the lease **after** the rate-limit check and **before** the provider
call, and release it in `finishOnce`.

Add the runtime declarations that are absent repo-wide:

```ts
export const runtime = "nodejs";
export const maxDuration = 60;   // must exceed FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS
```

Check both against `node_modules/next/dist/docs/` before writing them.

### `src/app/api/cron/prune/route.ts` (new) + `vercel.json`

Closes ADR 0015's named gap. `CRON_SECRET`-guarded (constant-time compare), deletes
`rate_limit_bucket` rows untouched for over 24h, returns a count. Bound the delete (`LIMIT` in a
subquery) so it cannot become an unbounded statement on a large table.

### `README.md` / `.env.example`

Document `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `TRUSTED_PROXY_HOP_COUNT`, `CRON_SECRET`, the
admission and budget limits, and the local Redis + `serverless-redis-http` docker commands from
`docs/plans/v4/README.md`. **State that all of it is optional** and the app runs without Redis —
that is the whole point of the fallback design.

### `.github/workflows/ci.yml`

Add `redis` and `serverless-redis-http` service containers to the jobs that need them, following
the existing `neon-proxy` service block's shape.

## Tests

- `lease.test.ts` — acquire/release balance to zero across all five terminal paths; the cap is
  enforced; TTL expiry frees a leaked slot; release is idempotent.
- `budget.test.ts` — under/over/at the cap; reconciliation matches the Redis counter; an unpriced
  model does not count as free; the guest global budget.
- `store.test.ts` additions — the Redis bucket matches the Postgres bucket's behaviour for the same
  input sequence. **Run the same table of cases against both backends** so they cannot drift; this
  is the parity discipline ADR 0014 applied to the two database drivers.
- `policy.test.ts` additions — hop-count selection with 0/1/2/3 XFF entries; a spoofed left entry
  does not change the bucket; the no-header path.
- Fallback tests — with the KV handle throwing on every call: limiting still works via Postgres,
  admission fails open, generation still succeeds. **This is the test that proves the "never
  authoritative" claim**; without it the claim is just a comment.
- `route.test.ts` additions — 429 `at-capacity` shape, budget-exceeded shape, and correct ordering
  of the three checks.
- E2E: a spec that opens two concurrent generations for one user and asserts the second is refused
  cleanly with a useful message (not a crash, not a hang).

## Verification

Full CI reproduction, plus:

- Re-run `npm run bench` from Plan 1. Concurrency refusals should appear as their own category.
  **Latency must not regress** — if TTFT p95 grew, the Redis calls are on the critical path in a
  way they should not be, and the timeout wrapper is wrong.
- Stop Redis (`docker stop fabula-redis`) and run the suite again. The app must still work. Do this
  by hand as well as in tests and say so in the PR.
- Manually confirm a leaked lease recovers: acquire, kill the process, wait for the TTL, confirm
  capacity returns.

## Gotchas

- **Do not put a Redis round trip in front of the first chunk without a timeout.** The cost
  optimisation must not become a TTFT regression. Measure it.
- `hasDatabase()` false currently disables limiting entirely (`guard.ts:26-29`). Decide
  deliberately what `hasKv()` false means for each new mechanism, and write it down — this is where
  a fail-open/fail-closed mistake hides.
- `src/lib/ratelimit/**` is at 100% coverage; `src/lib/kv/**`, `src/lib/admission/**` and
  `src/lib/budget/**` are new directories with no tier. Add them at 100% — they are exactly the
  "subtle code where a regression is expensive" the tiering comment in `vitest.config.mts`
  describes — and justify it in the PR.
- The E2E suite truncates `rate_limit_bucket` between tests (`e2e/helpers/db.ts:24`). Redis state
  needs the same treatment or tests will leak into each other. This is the ADR 0019 rate-limit trap
  in a new place.
- `@upstash/redis` must not be imported into a `"use client"` module. Keep it server-only.

## Out of scope

- A queue or a worker pool. Admission control **refuses** excess work; it does not defer it.
  Queueing is a much larger change and is not justified at this scale.
- Per-user API keys (BYOK), paid tiers, or billing — PRD §3 non-goals.
- Moving the feed or session data into Redis. Plan 3 owns caching.
- Alerting on budget exhaustion. Plan 7 owns metrics.

## ADRs

**`docs/adr/00NN-redis-as-a-non-authoritative-tier.md`**

- Why Redis, why Upstash's REST client specifically (no pool, works on Edge — the same constraint
  that chose `neon-http`).
- **The never-authoritative rule**, stated as a rule, with the per-operation fallback table. Why
  this mirrors the existing client-state-is-truth / DB-is-mirror posture.
- Why the Postgres token bucket is kept rather than replaced.
- Honest consequences: a new dependency, a new failure mode, a new thing to run locally and in CI,
  and two code paths to keep in parity — with the parity test named as the mitigation.

**`docs/adr/00NN-admission-control-and-spend-governance.md`**

- Rate limit versus concurrency limit, and why the existing token bucket was never the latter.
- Why leases carry a TTL, and why release lives in the existing `finishedOnce` latch rather than a
  second lifetime mechanism.
- Why the budget reconciles from `generation_event` instead of trusting Redis.
- Why guests share one global budget, and what that does and does not prevent.
- The trusted-proxy fix, and why leftmost-XFF is wrong.
- Refusing rather than queueing, and the trigger that would change that answer.
