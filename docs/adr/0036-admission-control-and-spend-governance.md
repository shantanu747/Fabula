# 36. Admission control and spend governance

## Status

Accepted.

## Context

Three separate holes, all the same shape: nothing bounds what one caller can consume.

1. **No concurrency limit anywhere.** The token bucket in `src/lib/ratelimit/` is a *rate*
   limit — it bounds requests per unit time, not requests in flight. `GENERATE_USER` (capacity
   20) lets one account open twenty simultaneous streams against the one shared provider key
   this app holds per provider (`registry.ts`), and `bench/BASELINE.md` (Plan 1) measured this
   is not a theoretical concern: the default 10-writer/10-turn benchmark workload 429s roughly
   80% of its calls today, at a *rate* limit, having never touched a concurrency limit at all.
2. **No spend limit.** `generation_event.costUsd` has been written since ADR 0022 and nothing
   had ever read it back. No per-user cap, no global cap, no circuit breaker.
3. **Most routes have no rate limit at all.** Only `/api/generate`, `/api/health`, and
   `/api/auth/register` were guarded; `/api/stories` (GET/POST), `/api/stories/[id]`
   (GET/PATCH), `/api/feed`, `/api/feed/[id]`, and `/api/stories/[id]/report` all reached
   Postgres unguarded.

Plus two defects in the existing limiter: `clientIp()` trusted the leftmost `x-forwarded-for`
entry, which is exactly the entry a caller controls when a proxy appends rather than rewrites;
and `rate_limit_bucket` had no pruning path, a gap ADR 0015 named explicitly and left open.

Spec: `docs/plans/v4/02-admission-control.md`. The Redis tier both mechanisms below are built
on is `docs/adr/0035`.

## Decision

**A concurrency lease is a different control than a rate limit, and the old limiter was never
going to become one.** A rate limit bounds *requests per unit time* from one identity; it says
nothing about how many of those requests are still open right now, which is exactly what
determines how many simultaneous provider connections one account can hold against the shared
key. `src/lib/admission/lease.ts`'s `acquireLease`/`release` pair is the actual concurrency
control: an atomic Redis script checks and increments a per-identity counter and a global
counter together (docs/adr/0035 has the atomicity argument), refusing if either is at capacity.

**Every lease carries a TTL (90s — `maxDuration` plus margin), because the alternative is a
capacity leak that never heals.** A crashed isolate that never reaches its own cleanup code
would otherwise hold its slot forever, and the only fix would be a manual Redis edit — a
single crash permanently and silently reducing the app's total concurrency until someone
notices generation refusals climbing for no visible reason. The TTL means a leaked lease
self-heals within one lease-lifetime, verified directly in `lease.db.test.ts` against a real
Redis (acquire to the cap, wait out a shortened TTL, confirm capacity returns) rather than
only asserted from reading the script.

**Release lives inside `finish()`, the function every one of `route.ts`'s terminal paths
already calls — not inside the `finishedOnce` latch, and not as a second lifetime-management
mechanism alongside it.** ADR 0022 already solved this exact problem for span lifetime: five
call sites end the span (the pre-stream try/catch's two outcomes, `start()`'s done branch,
`pull()`'s done branch and its catch, and `cancel()`), and only the three reachable *after* the
`ReadableStream` is constructed need the `finishedOnce` latch to prevent a double-run, because
only those three can race each other. `finish()` is the one function every one of those paths
already funnels through regardless of latch involvement, so that is where `lease.release()`
lives — one call, reached exactly once per request by construction, rather than duplicated
across five call sites or bolted onto a latch whose actual job is deduplication, not lifetime
management. `release` is additionally idempotent at the lease level (a `DECR` clamped at zero,
never a raw decrement past it), which is what makes a defensive extra call anywhere in this
chain harmless rather than a source of phantom capacity.

**The lease is acquired after persistence resolves, not immediately after the rate-limit
check, even though the plan's own file list describes the ordering the other way.** Every code
path *before* persistence resolves (a missing session on a `storyId` request, story-not-found,
a diverged-content 409) returns a plain `Response.json(...)` directly — none of them ever calls
`finish()`. Acquiring the lease before that block would mean those three paths need their own
manual release call, which is exactly the "second lifetime mechanism" the plan explicitly warns
against introducing. Acquiring it after persistence resolves means literally every subsequent
exit path — success, both provider-error shapes, both cancellation shapes — already funnels
through `finish()`, so release needs exactly one call site. This is a deliberate reading of
"before the provider call" (which it still is: `attemptFirstChunk()` is the very next thing
that happens), not a deviation from the plan's intent.

**Budget governance's asymmetric fail-open/fail-closed split is the load-bearing decision in
this file, not incidental.** The global daily cap fails **closed**: if Redis can't answer, it
falls back to a direct `SUM(costUsd)` query against `generation_event` (indexed for exactly
this — see below), and only if *that* also fails does it allow the request, loudly logged. This
is the one check standing between the app and an unbounded provider bill, so it is worth a
Postgres round trip to keep enforced even in a partial outage. The per-user (or shared guest)
cap fails **open** — skipped entirely when Redis can't answer, no Postgres fallback attempted —
because it is a nice-to-have bound on top of the global backstop, not itself the thing
protecting the org's spend; paying a database round trip to enforce a secondary control once
the primary one is already degraded was judged not worth the added latency or the added
Postgres load during exactly the kind of incident that doesn't need more load.

**Reconciliation happens on read, from a cold key, rather than as a periodic job.** Redis
counters are an accelerator; `generation_event` is the source of truth. `readOrReconcile` in
`src/lib/budget/index.ts` checks the Redis key first, and only on a genuine cache miss (`GET`
returns `null` — never written today, or evicted) recomputes the true total from Postgres and
seeds Redis with it before evaluating the cap. This one behaviour correctly handles both
readings of "cold key" without needing to distinguish them: a key that's cold because today is
new reconciles to the true value (0, or whatever's already accumulated if the app restarted
mid-day), and a key that's cold because Redis evicted it reconciles to the same real total
either way — there's no scenario where trusting a `null` as "zero spent" would be safe, so the
function never does. The daily rotation (one key per UTC calendar day, expiring at the next UTC
midnight) is what stands in for "periodic" reconciliation the plan's file list mentions: a new
day's key starts cold by construction, so it reconciles from Postgres exactly once at the start
of each day rather than needing a separate cron path to keep it honest.

**A composite index, not the incidental single-column one it replaces.** The reconciliation
query is `WHERE userId = $1 AND createdAt >= $2` (or with no `userId` predicate at all, for the
global and guest-shared totals) — a range on the second column, which the pre-existing
`generation_event_userId_index` cannot serve without a further sort or filter step.
`generation_event_userId_createdAt_index` replaces it, `DESC` written as raw SQL for the same
`NULLS LAST` mismatch reason `story_ownerId_updatedAt_index` already documents in
`schema.ts` — `createdAt` is `NOT NULL`, so this changes nothing semantically, only whether the
index is usable for the query planner.

**Three named populations, not one function parameterised by an optional `userId`.**
`src/lib/db/generationEvents.ts` gained `sumUserCostSince`, `sumGuestCostSince`, and
`sumGlobalCostSince` as three distinct functions rather than one taking `userId: string |
undefined`, because "every guest's spend" (`userId IS NULL`) and "everyone's spend" (no
predicate at all) are different queries, not the same query with a missing argument — collapsing
them would risk silently excluding every signed-in Writer's spend from the global total, which
is exactly the kind of bug a type signature should make hard to write rather than easy to.

**Guests share one global budget, not one each.** `clientIp()` is spoofable, and — per this
same ADR's ordering fix below — collapses to a single shared identity outright whenever no
proxy header is present. A per-guest budget keyed on that identity would hand a script that
rotates addresses (or simply has none to rotate) a fresh dollar allowance on every request,
which defeats the purpose of a cap entirely. One shared guest budget is the honest bound this
identity actually supports: it protects the org's total exposure to anonymous traffic, and it
does not, and cannot, stop one guest from spending the whole shared amount alone. Stated
plainly here because it's a real limitation, not a subtle implementation detail: this is what
"guest budget" can mean given guest identity's actual strength, not a compromise hiding a
stronger guarantee.

**`estimateCostUsd`'s `undefined` for an unpriced model is preserved in `generation_event`, and
overridden only for budget enforcement.** ADR 0022 already established that an unrecognised
model must report *no* cost attribute rather than a fabricated zero, so the durable
cost-history table stays honest. But an unpriced generation must still count against a spend
cap, or the way to bypass the cap becomes "use a model `PRICING` doesn't list." `recordSpend`
substitutes a conservative default (`$0.02` — roughly 1,000 input plus a full
`MAX_OUTPUT_TOKENS` output at the most expensive known per-token rate, Sonnet 5's) *only* for
the Redis counters it increments, logged loudly each time so a real gap in `PRICING` stays
visible rather than silently absorbed. `generation_event.costUsd` itself is never touched by
this substitution.

**The trusted-proxy fix: count from the right, not the left.** `x-forwarded-for` is only as
trustworthy as whoever wrote to it last. A proxy that *appends* the address it received the
request from — Vercel's behaviour — means every entry a trusted hop added lands on the right;
anything to the left of that is whatever the caller supplied, spoofable on every request. The
old code read the leftmost entry, which is exactly the attacker-controlled one. `clientIp()`
now reads the Nth entry from the right, where N (`TRUSTED_PROXY_HOP_COUNT`, default 1) is a
deployment-topology fact this codebase cannot infer on its own; a header with fewer entries
than the configured hop count is treated as untrustworthy rather than read out of range.

**The no-signal case gets a shared, stricter policy — not a fabricated per-browser identity.**
When no proxy header names anyone (`clientIp()` returns `"unknown"` — no proxy at all in front
of the app, which given Vercel always populates the header is realistically a local-dev or
self-hosted-without-a-proxy condition, not a production one), every such caller already shares
one bucket by construction (same hashed key). Rather than pretend that's an individual guest's
budget, `GENERATE_GUEST_UNIDENTIFIED` applies instead of `GENERATE_GUEST` for exactly that
identity: same burst (5 — a lone "clone it and try the guest flow" run still works with no
friction) but a 10x slower sustained rate, so a bucket that turns out to be absorbing more than
one real caller degrades to unusable quickly rather than quietly handing out a normal
per-caller allowance to an unbounded population. A cookie-based per-browser-session identifier
was considered and rejected for this pass: `proxy.ts`'s matcher explicitly excludes `/api/*`
routes, so introducing one would mean extending that matcher's scope (a change to
security-header/CSP-adjacent code well outside this plan's stated boundaries) purely to cover a
condition that doesn't occur in this app's documented deployment target at all.

**New rate-limit policies for the previously-unguarded routes, sized by cost shape rather than
one number for everything.** `STORIES_READ`/`FEED_READ` (60 burst, 1/s sustained) are generous
because a read is one indexed `SELECT`; `STORIES_WRITE` (10 burst, 1/10s) is modest because a
write costs an insert or an update-plus-ownership-check; `REPORT` (3 burst, 1/600s) is the
strictest policy in the file because it writes a row on *every* call regardless of the
`(storyId, reporterId)` unique constraint's own no-op-on-repeat behaviour, and a real reader
reports a story at most once or twice, ever.

## Consequences

- A user cannot hold more than 2 generations in flight; the app cannot exceed 50 regardless of
  how many distinct callers there are — both Redis-enforced when Redis is healthy, both a no-op
  (fail open) when it isn't.
- Daily spend is bounded per user ($2), per the shared guest population ($5), and globally
  ($100) — all three constants are order-of-magnitude starting points pending real traffic, the
  same posture ADR 0015 already took with its rate-limit numbers, and are meant to be tuned
  once real usage data exists rather than treated as load-bearing forever.
- Every route that touches Postgres now has a rate-limit policy.
- A spoofed `x-forwarded-for` no longer mints a fresh bucket; `rate_limit_bucket` gained a
  cron-triggered pruning path (`GET /api/cron/prune`, `CRON_SECRET`-guarded with a constant-time
  comparison, bounded to 10,000 rows per run) closing the gap ADR 0015 named.
- `maxDuration = 60` on `/api/generate` satisfies this plan's own stated arithmetic
  (`FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS` = 50s) but does not account for the one
  same-provider retry `attemptFirstChunk` can take on a fast, non-timeout failure — a legitimate
  retry-then-succeed sequence could in principle approach 70s. Recorded here rather than
  silently widened past what the plan specified: raising `maxDuration` past `50 +
  FIRST_CHUNK_TIMEOUT_MS` is the fix if this is confirmed as a real gap rather than an accepted,
  tighter number.

## Rejected

- **A queue or worker pool for excess generation requests.** Admission control *refuses* excess
  work; it does not defer it. A queue is a materially larger change (durable job state, a worker
  process, backpressure semantics) not justified at this scale — refusing with a clear,
  distinct message is the cheaper and more honest answer to "the app is at capacity right now."
- **Acquiring the lease immediately after the rate-limit check**, as the plan's file list
  literally describes — see Decision above for why acquiring it after persistence resolves
  instead avoids a second manual-release path for three early-return cases that never reach
  `finish()`.
- **A per-browser-session cookie for the unidentified-guest case** — would require extending
  `proxy.ts`'s matcher to cover API routes, out of this plan's scope for a condition this
  app's actual deployment target doesn't hit.
- **Falling back to Postgres for the per-identity/guest budget check** the way the global check
  does — would add a database round trip to enforce a secondary control after the primary
  backstop (the global cap) has already run, for marginal benefit.
