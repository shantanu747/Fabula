# 35. Redis as a non-authoritative tier

## Status

Accepted.

## Context

`docs/plans/v4/02-admission-control.md` needs two things nothing in the stack could
previously do at all: a concurrency (not rate) limit, and a daily spend cap read back from
real recorded cost. Both need a shared counter that many serverless invocations can update
with sub-request latency. Postgres can do this (ADR 0015 already does, for the rate limiter),
but a primary-key upsert round-trips through Neon's HTTP driver on every check — fine for one
check per request, not for admission and budget checks stacked on top of it too, and not for
the atomic increment-and-cap-check admission control specifically needs, which the rate
limiter's own single-statement upsert already proved is the only safe shape under concurrency
(ADR 0015's TOCTOU argument, restated below).

Spec: `docs/plans/v4/02-admission-control.md`.

## Decision

**A Redis tier, via `@upstash/redis`.** REST-based, not the wire protocol — no TCP connection
pool to manage on a serverless function, and it works in the Edge runtime (`proxy.ts` still
runs there, even though this plan's own consumers are all Node routes). This is the identical
reasoning that put `neon-http` in `src/lib/db/client.ts`: a driver whose transport matches how
this app actually runs, not the one with the richest local feature set.

**The rule that governs this entire plan: Redis is never authoritative.** It is a performance
and coordination tier over a Postgres source of truth — the same posture the app already takes
with client state versus the database (ADR 0007 for `StoryContext`, ADR 0009 for the
write-through mirror), applied one layer down. Concretely, per mechanism:

| Mechanism | Redis available and healthy | Redis absent/slow/erroring |
|---|---|---|
| Rate limiting | Redis Lua bucket answers | Falls back to the existing Postgres token bucket (ADR 0015), unchanged |
| Admission control | Redis Lua script enforces the cap | **Fails open** — no concurrency limiting, same as before this plan existed |
| Spend governance (global cap) | Redis counter answers | Falls back to a direct `generation_event` aggregate; if *that* also fails, allows and logs loudly |
| Spend governance (per-user/guest cap) | Redis counter answers | **Fails open** — skipped entirely, no Postgres fallback |

The asymmetry in the last two rows is deliberate, not an oversight: the global cap is the one
control standing between the app and an unbounded bill, so it pays for a Postgres round trip
to stay enforced; the per-identity cap is a nice-to-have on top of that backstop, and isn't
worth a query of its own once Redis is already down. `docs/adr/0036` explains the admission and
budget reasoning in full; this ADR is about the tier they both sit on.

**The Postgres token bucket is kept, not replaced.** `src/lib/ratelimit/store.ts` gained a
Redis strategy *behind the unchanged `consumeToken(db, policy, identity)` signature* — the
caller in `guard.ts` cannot tell which backend answered, and never learns to. Deleting the
Postgres path would mean rate limiting itself is one Redis outage away from an unbounded
provider bill, which is exactly the property ADR 0015 exists to prevent. The Redis bucket is
one atomic Lua script — read tokens and last-refill, refill by elapsed time, cap at capacity,
decrement if ≥1, write back, return the result — the direct translation of the existing
single-statement SQL upsert, and atomic for the identical reason: a Lua script runs to
completion with nothing else able to interleave, so the whole read-modify-write happens
somewhere no concurrent caller can observe halfway through. The same argument the SQL
statement's comment already makes (two callers both reading "four tokens left" and both
proceeding is the paragraph-position TOCTOU restated) applies verbatim to two Lua invocations
racing on the same key — except Redis has no equivalent of Postgres's per-key upsert
serialisation to lean on, so the script itself has to be the whole operation, not a read
followed by a write.

**Admission control's cap-and-increment is the same atomicity argument, one level up.**
`src/lib/admission/lease.ts`'s acquire script checks *two* counters (per-identity and global)
and increments both only if neither is over cap — one script, so a caller can never observe
"identity cap ok" and act on it after the global cap has since filled, which two separate
`GET`/`INCR` round trips would allow.

**Every Redis operation is wrapped in a timeout** (`src/lib/kv/client.ts`'s `withKvTimeout`,
250ms default). A hung Redis must not add latency in front of TTFT — the streaming
architecture (ADR 0003) exists specifically to optimise that number, and a slow cost
optimisation sitting in front of it would be a regression wearing the cost optimisation's
clothes. `withKvTimeout` collapses "didn't answer in time" and "threw" into the same
`undefined`, on purpose: every caller's fallback decision is identical either way, so there is
exactly one place that collapsing happens rather than one per call site.

**Lazy construction, mirroring `getDb()`.** `src/lib/kv/client.ts`'s `getKv()` doesn't
construct a client at module scope, for the same reason `createDb()` doesn't: a contributor
who clones the repo without provisioning Redis must still be able to run `next build`/`next
dev` and use the guest flow. `hasKv()` mirrors `hasDatabase()`'s exact shape (`kv !== undefined
|| Boolean(process.env.KV_REST_API_URL)`) so the test suite's injection seam
(`__setKvForTests`) counts as "configured" the same way `__setDbForTests` already does.

**Local and CI parity via `serverless-redis-http`.** `@upstash/redis` speaks Upstash's HTTP
REST protocol, not the Redis wire protocol, so it cannot talk to a plain `redis:8-alpine`
container directly — `hiett/serverless-redis-http` in front of one gives the exact protocol the
production client speaks, the identical role `local-neon-http-proxy` already plays for
Postgres (ADR 0014). `docs/plans/v4/README.md`'s docker commands and this repo's CI
(`.github/workflows/ci.yml`) both wire it in as a service container next to the existing
Postgres one.

**Test isolation cannot mirror the Postgres pattern, and that's a deliberate choice, not a
gap.** The Vitest `db` project clones a fresh, per-worker Postgres database from a template
(`src/test/db-names.ts`'s `workerDbName()`) — multiple forked worker processes never share
state because each owns its own database. Redis has no equivalent per-worker isolation
mechanism available here, and it's a single shared instance across every forked worker in that
project. A global `FLUSHALL` before each test — the naive Postgres-truncate analogue — was
tried and rejected: with parallel workers, one worker's flush wipes another worker's
in-progress bucket mid-test, which surfaced immediately as a real, reproducible failure (a
5-request burst test suddenly allowing all 5 instead of denying past capacity, because a
concurrent worker's flush reset the counter between two of the five calls). The fix that
actually holds under parallelism: every Redis-touching test uses a fresh
`crypto.randomUUID()`-derived key so tests never collide with each other in the first place,
and every Redis key carries a real TTL (the bucket script's own expiry, the lease TTL) so
nothing durably leaks even without an explicit reset. The E2E suite is different and *can* use
a global flush safely — `playwright.config.ts` pins `workers: 1`, so there is no concurrent
worker to corrupt; `e2e/helpers/db.ts`'s `resetDatabase()` flushes Redis there, the same
`rate_limit_bucket`-truncation trap ADR 0019 named, in a new place with a different, correct
mitigation for its different concurrency model.

**Files that specifically need a real Redis are named for it and fail loudly without one.**
`store.parity.db.test.ts` and `lease.db.test.ts` throw a clear, actionable error (matching
`global-setup-db.ts`'s existing "cannot reach Postgres" message shape) if `KV_REST_API_URL`
isn't set, rather than silently skipping — a skipped assertion that nobody notices is worse
than a loud failure that names the missing docker command. Every *other* `db.test.ts` file
(the existing `store.db.test.ts`, and the new `guard.db.test.ts`/`route.db.test.ts` additions)
explicitly neutralises `KV_REST_API_URL`/`KV_REST_API_TOKEN` for its own tests via
`src/test/kv.ts`'s `neutralizeKvForEachTest()`, because CI necessarily sets these at the job
level for the two files that do need them (`npm run test:coverage` runs the `unit` and `db`
Vitest projects in one process, sharing one `process.env`) — the identical ambient-env trap
this repo already knows about `DATABASE_URL` (AGENTS.md names the exact incident: "a
rate-limit-guarded route test has already passed locally with `DATABASE_URL` unset, then
failed in CI once the job-level `DATABASE_URL` leaked into it"). Every unit-project test file
that asserts on "Redis absent" behaviour applies the same neutralisation for the same reason.

## Consequences

- A new runtime dependency (`@upstash/redis`), a new local/CI service to run, and a new
  failure mode — all judged worth it because the alternative (admission control and spend
  governance implemented as more Postgres round trips) would add exactly the per-request
  latency this plan exists to avoid adding.
- Two code paths now answer every rate-limit check, and they must never drift. The mitigation
  is `store.parity.db.test.ts`: the same table of behavioural cases run against both backends,
  the ADR 0014 parity discipline applied to a second pair of implementations.
- A Redis outage degrades the app to exactly its pre-this-plan behaviour (Postgres-limited
  rate limiting, no concurrency cap, no spend cap) rather than to an error — verified by hand
  (`docker stop` against the local container, full suite re-run) as well as in the fallback
  test suite named above.
- Test isolation for Redis state relies on per-test randomised keys and real TTLs rather than
  a blanket reset, because the naive reset is actively unsafe under this project's parallel
  Vitest workers — a fact only discovered by hitting it, and worth stating plainly so nobody
  reintroduces a global flush into `src/test/setup-db.ts` later without rediscovering why it
  broke.

## Rejected

- **Deleting the Postgres rate-limit bucket** once Redis exists — would make rate limiting,
  and therefore the app's entire cost-control story, dependent on Redis's uptime.
- **A blanket Redis `FLUSHALL` in the Vitest `db` project's shared setup**, mirroring the
  Postgres truncate — unsafe under that project's parallel forked workers, which don't get a
  Redis-per-worker the way they get a Postgres-per-worker. Kept for the E2E suite, which runs
  with `workers: 1` and has no such hazard.
- **Silently skipping the Redis-dependent test files when `KV_REST_API_URL` is absent** —
  would let the parity and lease-TTL assertions quietly stop running for anyone who hasn't
  provisioned local Redis, the same "worse than no limiter" reasoning ADR 0015 already applied
  to a silently-off rate limiter.
