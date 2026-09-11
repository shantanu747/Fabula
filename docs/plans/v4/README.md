# Fabula v4 — implementation plans

Eight changes, one branch each, implemented one at a time. These plans are written to be
executed by an agent with no prior context on the conversation that produced them.

v1–v3 built the product and its quality infrastructure: the provider abstraction, streaming,
turn policy, accounts, persistence, the shared feed, an eval harness, E2E journeys, OTel traces,
security headers, and CI quality gates (ADRs 0001–0029).

**v4 is about what happens when more than one person uses it at once, on a bad day, with a real
bill.** The gaps it closes are not feature gaps:

- There is no concurrency cap, no queue, and no admission control anywhere in the codebase. The
  rate limiter is a *rate* limit, not a *concurrency* limit.
- `generation_event.costUsd` has been recorded since ADR 0022 and is never read back to enforce
  anything. There is no spend cap and no circuit breaker.
- There is no cache of any kind — no `unstable_cache`, no `revalidateTag`, no React `cache()`, no
  in-memory cache, no `Cache-Control` on the read routes, and **no provider prompt caching**.
- One `POST /api/generate` on a saved story is six sequential `neon-http` round trips, and
  `syncStoryParagraphs` re-reads the full text of every stored paragraph on every turn.
- A mid-stream failure has no in-band representation: the body simply ends. There is no resume.
- `authorize()` has no rate limit, there is no email verification, no password reset, no session
  revocation, and no Origin/CSRF check on the app's own mutating routes.
- `grep -rn "metrics|Meter|createCounter|histogram" src/` returns zero hits. One span exists in
  the entire application.

## Rules that apply to every plan on this list

1. **Read `AGENTS.md` first, in full.** Everything in it applies. In particular: read the relevant
   guide under `node_modules/next/dist/docs/` before writing Next.js-specific code — this is
   Next 16.3 and the APIs differ from training data. Note that `middleware.ts` is `proxy.ts` here.
2. **Check the knowledge graph before grepping.** `graphify query "<question>"`,
   `graphify explain "<concept>"`, `graphify path "<A>" "<B>"`. Fall back to a wider search when
   the graph is thin — it is a starting point, not a ceiling. Run `graphify update .` when asked,
   not automatically.
3. **The completion bar is CI, reproduced locally.** Run every step `.github/workflows/ci.yml`
   runs, within each job, with CI's exact job-level env:

   ```bash
   # build job
   npm run lint && npx drizzle-kit check && npm run test:coverage && npm run eval && npm run build
   # quality job  (rm -rf .next first — a cached build changes chunk hashes; ADR 0027)
   npm run typecheck && npm run test:scripts && rm -rf .next && npm run build && npm run bundle-budget
   # e2e job
   npm run test:e2e
   ```

   with `ANTHROPIC_API_KEY=test-key OPENAI_API_KEY=test-key OPENROUTER_API_KEY=test-key
   DATABASE_URL=postgres://user:pass@localhost:5432/fabula AUTH_SECRET=ci-placeholder-secret` set
   at job level. Setting `DATABASE_URL` matters even for tests that seem not to need it — a
   rate-limit-guarded route test has already passed locally with it unset and failed in CI with it
   set. If a plan adds a CI step, that new step joins this list.

4. **Local services.** Postgres and the Neon HTTP proxy as before; **v4 adds Redis** from Plan 2
   onward:

   ```bash
   docker run -d --name fabula-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -p 5432:5432 postgres:17-alpine
   docker run -d --name fabula-redis --network fabula-net -p 6379:6379 redis:8-alpine
   docker run -d --name fabula-srh --network fabula-net -p 8079:80 \
     -e SRH_MODE=env -e SRH_TOKEN=dev -e SRH_CONNECTION_STRING=redis://fabula-redis:6379 \
     hiett/serverless-redis-http:latest
   ```

   `@upstash/redis` speaks HTTP, so `serverless-redis-http` in front of stock Redis gives exact
   driver parity locally and in CI — the same reasoning that produced the Neon HTTP proxy harness
   in ADR 0019. Plan 2 adds these as CI service containers and documents them in `README.md`.

5. **Every plan ends in at least one ADR** under `docs/adr/`, in the format described in
   `docs/adr/README.md` (Status / Context / Decision / Consequences), plus a new line in that
   file's index. The next unused number at the time of writing is **0034** (the visual redesign took 0029–0033); take the next unused
   number when you branch, and if two branches claim the same one, the later to merge renumbers.
6. **Do not expand scope.** Each plan has an explicit "Out of scope" section. If implementing one
   surfaces a genuine gap in the spec, stop and flag it rather than improvising.
7. **Coverage thresholds in `vitest.config.mts` are tiered and enforced.** `src/lib/story/**`,
   `src/lib/ratelimit/**`, `src/lib/observability/**`, and
   `src/lib/providers/{prompt,registry,list,constants,types,pricing}.ts` are held at **100%**.
   Adding an untested line to any of those fails CI. New directories (`src/lib/kv/**`,
   `src/lib/email/**`) must pick a tier deliberately and say why in the PR.
8. **Responsive is not optional.** Any UI-touching change is checked at ~375px as well as desktop
   before it is called done, and `npm run bundle-budget` is re-run after a clean `rm -rf .next`.
9. **Fill in `.github/pull_request_template.md` honestly.** "Tests pass" is not an answer to the
   Testing section.

## Merge order (not arbitrary — six of these share dependencies)

| # | Branch | Depends on | Why |
|---|---|---|---|
| 1 | `feature/load-harness` | — | Produces the "before" numbers plans 2 and 3 are measured against. Nothing else can honestly claim an improvement until this exists. |
| 2 | `feature/admission-control` | 1 | Introduces `src/lib/kv/` — plans 3, 4, 5 and 6 all consume it. |
| 3 | `feature/caching-and-data-model` | 2, 1 | Needs the Redis client; its migrations should land before 4 starts editing the same route. |
| 4 | `feature/streaming-protocol-v2` | 2 | Needs Redis for the resume buffer. Heavy `generate/route.ts` edits, so it follows 3 rather than racing it. |
| 5 | `feature/resilience` | 4, 2 | Client recovery is written against 4's framed error events. |
| 6 | `feature/account-lifecycle` | 2 | Needs the rate-limit policies; otherwise independent of 3–5 and can run in parallel with them. |
| 7 | `feature/metrics-and-slos` | 2–6 | Instruments every surface the others add. Lands last so it does not chase moving targets. |
| 8 | `feature/ui-redesign-followups` | `design/redesign` merged | Independent of 1–7 (no Redis, no schema). Finishes the visual redesign: commits its spec, adds visual-regression and dark-scheme gates, and closes the deferred decisions. |

If you must go out of order, each plan's "If the dependency isn't merged yet" note says what to do.

## The plans

1. [Capacity benchmark harness](01-load-harness.md) — measured TTFT percentiles, throughput, DB
   round trips per operation, and cost per story, against the existing mock provider.
2. [Admission control and spend governance](02-admission-control.md) — a Redis tier that is never
   authoritative, in-flight concurrency leases, daily spend caps, and the rate limits that are
   missing today.
3. [Caching, prompt caching, and the data model](03-caching-and-data-model.md) — a stable prefix so
   provider caches can hit, denormalized counters, keyset pagination, and a server-rendered feed.
4. [Streaming protocol v2](04-streaming-protocol-v2.md) — SSE with typed frames, in-band mid-stream
   errors, and resume after disconnect.
5. [Resilience and graceful degradation](05-resilience.md) — error boundaries, durable Writer
   turns, idempotent story creation, honoured `Retry-After`, and a provider circuit breaker.
6. [Account lifecycle and auth hardening](06-account-lifecycle.md) — verification, password reset,
   session revocation, login rate limiting, Origin checks, and the prompt trust boundary.
7. [Metrics, SLOs, and client telemetry](07-metrics-and-slos.md) — OTel metric instruments, spans
   beyond the one that exists, request ids everywhere, and RUM without a vendor.
8. [UI redesign follow-ups](08-ui-redesign-followups.md) — commit the design spec the ADRs cite,
   visual-regression snapshots and a dark-scheme axe pass in CI, a focus indicator for the
   borderless composer, the dev-mode duplicate feed rows, and the three deferred handoff intents
   (prefill, canvas length control, Share as a toggle) as explicit decisions.
