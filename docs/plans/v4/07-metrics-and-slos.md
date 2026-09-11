# Plan 7 — Metrics, SLOs, and client telemetry

**Branch:** `feature/metrics-and-slos`
**Depends on:** plans 2–6. **Lands last**, so it instruments finished surfaces rather than chasing
moving ones. *If some plans aren't merged:* instrument what exists and leave the rest; do not
pre-emptively add instruments for code that is not there.
**ADR:** required.

## Why this exists

ADR 0022 built traces, structured logs, and cost accounting, and named its own gaps. Those gaps are
now the limiting factor on everything v4 added — admission control, budgets, circuit breakers and
caches are all things you cannot operate without being able to see them.

Concretely:

- **There are no metrics.** `grep -rniE "metrics|Meter|createCounter|histogram" src/` returns
  **zero hits**, despite `@opentelemetry/sdk-logs` and `api-logs` being direct dependencies. Error
  rate is *derivable* from `fabula.outcome` span attributes, but nothing aggregates, counts, or
  alerts.
- **There is one span in the entire application** — `fabula.generate`
  (`src/app/api/generate/route.ts:160`). Nothing on `/api/stories`, `/api/feed`, `/api/auth/*`,
  `/api/health`, and nothing on any database call. The six-round-trip turn is invisible in a trace.
- **Request ids exist on one route.** `resolveRequestId` is called only by `/api/generate`
  (`:77`), so no other route's logs correlate to anything.
- **Rate-limit internals bypass the structured logger** — raw `console.warn`/`console.error` at
  `guard.ts:27,35`.
- **`RATELIMIT_REJECTED` is logged for `/api/generate` only**, not for register or health.
- **No client-side telemetry at all.** `error.tsx:23` is a `console.error`. No web vitals, no client
  error reporting — so a hydration failure or a bundle regression is invisible.
- **Nothing reads `generation_event` back.** ADR 0022 added it for SQL-queryable cost history and no
  query has ever been written against it.

## What "done" means

- Every operation v4 added has a metric: admission refusals, budget exhaustion, circuit-breaker
  state, cache hit rate, resume attempts.
- Every API route produces a span; database calls appear as child spans.
- Every request carries a request id, on every route, correlated into every log line.
- Web vitals and client errors reach the same pipeline, with no PII and no vendor.
- Operational targets are written down as code, with a report that says whether they are being met.
- The privacy guarantee is unchanged: no prose, no email, no raw IP, anywhere.

## Files

### `src/lib/observability/metrics.ts` (new)

OTel metric instruments via `@opentelemetry/api`'s meter, exported over OTLP by the existing
`@vercel/otel` registration. No new dependency, no new exporter, no code change to switch backends —
the same property ADR 0022 established for traces.

| Instrument | Type | Attributes |
|---|---|---|
| `fabula.generation.ttft` | histogram (ms) | provider, model, authenticated |
| `fabula.generation.duration` | histogram (ms) | provider, outcome |
| `fabula.generation.tokens` | histogram | provider, kind (input/output/cache_read/cache_write) |
| `fabula.generation.cost_usd` | histogram | provider, model |
| `fabula.generation.outcome` | counter | provider, outcome |
| `fabula.generation.in_flight` | up-down counter | — |
| `fabula.ratelimit.rejected` | counter | policy |
| `fabula.admission.rejected` | counter | reason (per_user / global) |
| `fabula.budget.exceeded` | counter | scope (user / global / guest) |
| `fabula.provider.circuit` | counter | provider, transition |
| `fabula.cache.prompt` | counter | provider, result (hit/miss/write) |
| `fabula.stream.resume` | counter | result |
| `fabula.auth.login` | counter | result (success / bad_password / unknown_user / rate_limited) |
| `fabula.db.roundtrips` | histogram | route |

**Attribute cardinality is the trap.** Every attribute value multiplies the stored series. Provider
ids, model ids, and outcomes are bounded sets. A user id, story id, request id, or raw error message
is not — those belong on spans and log lines, which are per-event, never on metric attributes.
State that rule in the ADR; it is the metrics equivalent of the logger's allowlist, and it is the
mistake that makes an observability bill exceed a hosting bill.

`src/lib/observability/**` is at **100% coverage**.

### `src/lib/observability/withRoute.ts` (new)

A wrapper giving every route handler a span (`http.route`, `http.method`, `http.status_code`,
`fabula.request_id`), a resolved request id, an `x-request-id` response header, and consistent error
logging.

Apply to every route under `src/app/api/**`. Leave `/api/generate`'s richer `fabula.generate` span
in place as a child — do not flatten it.

### `src/lib/db/tracing.ts` (new)

A `Proxy` over `AppDatabase` emitting a child span per statement.

This is the **third** use of this technique: `src/test/latch.ts` (deterministic race tests, ADR
0014) and Plan 1's round-trip counter. Extend Plan 1's wrapper rather than writing a third one — the
counting and tracing concerns compose over the same interception point.

`db.statement` carries the **statement shape, never bound values**. Story prose passes through these
calls as parameters, and ADR 0022's privacy line is structural, not a review convention. Test that a
paragraph's text cannot appear in a span attribute, the way `route.test.ts` already asserts it for
the generate span.

This makes the six-round-trip turn visible as six child spans — and, after Plan 3, three.

### `src/proxy.ts` (modify)

Mint the request id here so it exists before any route sees it, and propagate it via a header.
Validate an inbound `x-request-id` with the existing `resolveRequestId` (`requestId.ts:14`) — an
unvalidated header echoed into logs is a log-injection vector, which is why that validation exists.

Note `proxy.ts` runs on **Edge**: no `node:` imports (the constraint `instrumentation.ts:4-5`
already documents).

### `src/app/api/telemetry/route.ts` (new) + `src/components/WebVitals.tsx` (new)

Client telemetry with no vendor:

- `useReportWebVitals` (built into Next — check the bundled docs; no dependency) posts LCP, INP, CLS,
  TTFB.
- `error.tsx` and `global-error.tsx` post `error.digest` and the route. **Never** the message or the
  stack — a client error message can contain user text.
- The endpoint validates strictly against an allowlist of metric names, rate limits (a Plan 2
  policy), accepts no free-form strings, and records to the same OTel instruments.

Treat the body as untrusted: it is a public, unauthenticated endpoint that writes into your metrics.
Cardinality limits matter here more than anywhere else — reject unknown names rather than recording
them.

Keep it small; it lands in every route's bundle. Check `budgets.json`.

### Structured logging gaps

- Replace `guard.ts:27,35`'s raw `console.*` with the structured logger.
- Emit `RATELIMIT_REJECTED` from register and health, not just generate.
- Add sampling for high-volume non-error events (`generate.first_chunk`), configurable, defaulting
  to full. **Errors are never sampled.**

### `src/lib/observability/slo.ts` + `scripts/slo-report.mts` (new)

Operational targets as code — e.g. generation success rate, TTFT p95, feed p95, availability — each
with the target, the window, and a one-line rationale. Vague targets are worse than none.

`scripts/slo-report.mts` queries `generation_event` and prints attainment. This is the first query
ever written against that table, which is the point: ADR 0022 chose Postgres over trace storage
specifically so cost and outcome history would be SQL-queryable, and that claim has never been
exercised.

Runs under the existing `npm run test:scripts` for its pure parts.

### `README.md`

Extend the Jaeger-only loop from ADR 0022 to a full local stack (OTel collector + Prometheus +
Grafana + Jaeger) via docker compose, with the env vars. Metrics you cannot look at are not
observability — the same reasoning that put the Jaeger instructions in the README originally.

## Tests

- `metrics.test.ts` — instruments record with expected attributes; **no unbounded attribute value is
  ever passed** (assert against a list of forbidden keys: user id, story id, request id, raw
  messages).
- `withRoute.test.ts` — exactly one span per request including error paths; `x-request-id` on every
  response including errors; an invalid inbound id is replaced, not echoed.
- `tracing.test.ts` — a child span per statement; **statement shape only**; assert a known paragraph
  string cannot appear in any attribute.
- `telemetry/route.test.ts` — unknown metric names rejected; oversized bodies rejected; no
  free-form string reaches an attribute; rate limited.
- `slo.test.ts` — attainment arithmetic against fixture rows, including the empty-window case.
- Sampling tests — sampled events drop at the configured rate; **errors never sample out**.

## Verification

Full CI reproduction, plus:

- Bring up the local collector stack, run `npm run bench`, and confirm by eye: TTFT histogram
  populated, DB round-trip child spans visible per turn, admission/budget/circuit counters moving
  under load. **Say in the PR that you looked**, as ADR 0022 required for traces.
- Confirm one trace spans proxy → route → database for a non-generate route.
- Run `scripts/slo-report.mts` against the bench data and confirm it produces sane numbers.
- Grep the collector output for a story paragraph from the bench fixture. **It must not appear
  anywhere.** This is the privacy guarantee and it deserves a direct check, not just a unit test.
- `rm -rf .next && npm run build && npm run bundle-budget` — the web-vitals component ships to every
  route.

## Gotchas

- **Metric cardinality.** The single most expensive mistake available in this plan.
- `@vercel/otel` with no `OTEL_EXPORTER_OTLP_ENDPOINT` must remain a **no-op, not a crash** —
  CI has it unset (`instrumentation.ts:7-9`). Verify `npm run build` and `npm run dev` both work
  with it unset.
- `next build` executes module scope. Instrument creation must be lazy and side-effect-free.
- `proxy.ts` is Edge: no `node:` imports.
- Do not import the server logger or metrics into a `"use client"` module. The client path goes
  through `/api/telemetry`.
- Wrapping every database call in a span adds overhead. Re-run `npm run bench` and confirm it is
  negligible; if it is not, sample the DB spans.
- `/api/telemetry` is unauthenticated and public. It is an attack surface on your metrics pipeline.

## Out of scope

- Deploying a collector, dashboards-as-code, or alert routing — that is hosting, not application
  code.
- Sentry or any error-tracking vendor.
- Session replay, product analytics, or user-behaviour tracking. This is operational telemetry;
  keep the distinction sharp in the ADR.
- Distributed tracing across services. There is one service.

## ADR

`docs/adr/00NN-metrics-slos-and-client-telemetry.md`. Cover:

- Why OTel metric instruments rather than deriving everything from span attributes: spans are
  sampled and expire; counters and histograms are what you alert on.
- **The cardinality rule**, as the metrics counterpart to ADR 0022's logging allowlist — which
  attributes are permitted on a metric and why unbounded ids are confined to spans and logs.
- Why RUM is a first-party endpoint rather than a vendor SDK: no third-party script (the CSP from
  ADR 0024 would have to be loosened to allow one), no PII leaving the app, and the same OTLP
  pipeline.
- Why `error.digest` only, never the message.
- Why database spans reuse the established Proxy technique rather than a fourth mechanism.
- Why SLOs live in code with a SQL report, and what ADR 0022's `generation_event` decision was
  ultimately for.
- Consequences: telemetry volume is now a cost line, sampling is a lever, and the privacy guarantee
  is preserved structurally rather than by review.
