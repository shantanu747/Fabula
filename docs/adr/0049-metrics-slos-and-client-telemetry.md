# 49. Metrics, SLOs, and client telemetry

## Status

Accepted.

## Context

ADR 0022 built traces, structured logs, and cost accounting, and named its own gaps. By the time
v4's other plans landed — admission control, spend governance, caching, a resumable streaming
protocol, resilience, account lifecycle — those gaps had become the limiting factor on operating
any of it: `grep -rniE "metrics|Meter|createCounter|histogram" src/` returned zero hits despite
`@opentelemetry/sdk-logs` and `api-logs` already being direct dependencies, exactly one span
existed in the whole application (`fabula.generate`), only `/api/generate` carried a request id,
rate-limit internals bypassed the structured logger entirely, and there was no client-side
telemetry of any kind. Spec: `docs/plans/v4/07-metrics-and-slos.md`.

## Decision

**OTel metric instruments, not derived-from-span-attributes.** Spans are sampled and expire; a
counter or histogram is what a dashboard alerts on. `fabula.outcome` living on `fabula.generate`'s
span attributes (ADR 0022) answers "what happened on this one request," never "what is the error
rate right now" — that requires an aggregated, always-on time series, which only a metric
instrument provides.

**Every metric instrument is created lazily, on first use — not at module scope, and not for the
reason `route.ts`'s tracer already satisfies.** `route.ts`'s module-scope `tracer =
trace.getTracer("fabula")` is safe purely because `@opentelemetry/api`'s Trace API is backed by a
`ProxyTracerProvider`: a tracer obtained before `instrumentation.ts`'s `register()` finishes still
works once a real `TracerProvider` is registered a moment later, because the proxy's *delegate* is
swapped in place. Reading the Metrics API's own source (`@opentelemetry/api`'s
`api/metrics.js`) rather than assuming symmetry: `MetricsAPI.getMeter()` calls
`getMeterProvider().getMeter()` directly, with no such proxy. A histogram created from a meter
obtained before the real `MeterProvider` is registered binds *permanently* to the no-op provider —
silently, with no error, forever, even after the real provider is registered later. `metrics.ts`'s
`lazyHistogram`/`lazyCounter`/`lazyUpDownCounter` defer both the meter lookup and the instrument
creation to a recorder function's first actual call, which for every one of them only ever happens
from inside a request handler — after Next's own documented guarantee that `register()` "must
complete before the server is ready to handle requests." This is the plan's own gotcha
("Instrument creation must be lazy") traced back to its actual mechanism rather than treated as a
restatement of the tracer pattern.

**`@vercel/otel` needs an explicit `metricReaders` entry — traces do not, and that asymmetry is a
plan-correcting finding, not an assumption.** The plan's own text claimed wiring in metrics would
need "no new dependency, no new exporter." Reading `@vercel/otel`'s source
(`dist/node/index.js`) shows a `MeterProvider` is only constructed at all when `metricReaders` or
`views` is passed — `registerOTel`'s `traceExporter` defaults to `"auto"`, which reads
`OTEL_EXPORTER_OTLP_ENDPOINT` itself; there is no equivalent default for metrics. `@vercel/otel`
also exports no OTLP metric exporter (only `OTLPHttpJsonTraceExporter`/`OTLPHttpProtoTraceExporter`
for traces), and `@opentelemetry/sdk-metrics` is only its *peer* dependency — present in
`node_modules` only because another package happened to pull it in transitively, never declared by
this app. `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-proto` are now
direct dependencies (pinned to the same version lines `sdk-trace-base`/`api-logs` already use), and
`instrumentation.ts` explicitly constructs a `PeriodicExportingMetricReader` behind the same
"no endpoint configured, no-op" guard `@vercel/otel` already applies to traces. This is still
squarely "OTel over a vendor SDK" — two more packages from the same vendor-neutral toolkit, not a
new architecture — but the plan's claim of zero new dependencies was wrong, and is corrected here
rather than silently worked around.

**The reader itself lives in a separate `instrumentation.metrics.ts`, reached only through a
dynamic `import()` gated on `NEXT_RUNTIME === "nodejs"`.** `instrumentation.ts` is loaded in both
the Node and Edge runtimes (`proxy.ts` shares its Edge constraint). A static import of a
Node-oriented HTTP/zlib-based OTLP exporter there would pull it into the Edge bundle. This follows
Next's own documented pattern for runtime-specific instrumentation code rather than inventing one.

**The cardinality rule — the metrics counterpart to the logger's redaction allowlist.** A metric
attribute multiplies the number of stored time series; an unbounded value here (a user id, a story
id, a request id, a raw message) is the mistake that makes an observability bill exceed a hosting
bill. `metrics.ts` makes this structural, not a review convention, the same way `logger.ts`'s
`ALLOWED_FIELDS` does: every instrument is a private module-scope variable, and the *only* way to
write to one is through a typed recorder function whose parameters are bounded enums (`"success" |
"provider_error" | ...`), never a free string. `metrics.test.ts`'s own assertion — that no data
point anywhere carries `userId`/`storyId`/`requestId`/`email`/`message`/`text` — proves this at the
data layer, the same "assert against a fixture, don't just trust the type system" discipline
`route.test.ts` already applied to span attributes.

**`fabula.auth.login`'s result values were changed from the plan's literal spec, deliberately.**
The plan proposed `success / bad_password / unknown_user / rate_limited`. `authorize.ts` (Plan 6)
deliberately collapses "no such account" and "wrong password" into one undifferentiated
`invalid_credentials` outcome, and always runs `bcrypt.compare` against a dummy hash when no user
exists, specifically so response timing cannot tell an attacker whether an email has an account.
Splitting the metric into `bad_password`/`unknown_user` would reopen exactly that channel through a
clearer signal than timing ever was: an attacker could watch which bucket increments after a
guessed login and learn account existence in one read, no statistics needed. Raised with the user
directly rather than resolved silently either way; the answer was to collapse the metric to match
`authorize.ts`'s existing posture (`success / invalid_credentials / rate_limited`), deviating from
the plan's literal attribute list to preserve a security property already established.

**`fabula.admission.rejected`'s `reason` (per_user / global) required changing `lease.ts`'s Lua
script, not just reading an existing field.** `acquireLease`'s refusal case previously returned a
bare `{ acquired: false, retryAfterSeconds }` — the Redis script itself only ever returned a single
0/1, with no way to tell which of the two caps (per-identity or global) refused the request.
`ACQUIRE_SCRIPT` now returns 0 for an identity-cap refusal and 2 for a global-cap refusal (checked
in that order, so a simultaneous double-refusal reports the one the caller can act on), and
`LeaseResult`'s refused variant carries the `AdmissionReason` this metric needs. Covered by two new
`lease.test.ts` cases (`createFakeAdmissionKv`'s fake updated to match the new return codes) rather
than assumed correct from the type change alone.

**`fabula.provider.circuit`'s transitions required the same treatment in `circuitBreaker.ts`.**
`RECORD_FAILURE_SCRIPT` previously returned `1` unconditionally; it now returns `2` specifically
when a call just (re-)opened the breaker (either the probe-failed re-open branch or crossing
`FAILURE_THRESHOLD`), so `recordBreakerOutcome` can record an `"opened"` transition exactly once
per real state change rather than once per failure. The success path's `recordProviderCircuit(...,
"closed")` is gated on `del()`'s own return value (the count of keys it actually deleted) — a
success against an already-closed breaker deletes nothing and correctly records no transition.

**`fabula.db.roundtrips` needed a route to attribute a count to, from inside a process-wide
singleton, without threading it through every function signature.** `db/client.ts`'s `getDb()` is
constructed once per process (bench's own round-trip counter, ADR 0034, already established this).
`requestContext.ts` carries a per-request round-trip counter (and the request id `withRoute.ts`
already resolved) through OTel's own context propagation — the identical mechanism `route.ts`
already uses to keep its span active across `driveGeneration`'s awaits. Verified directly, not
assumed: without a registered `ContextManager`, even a *synchronous* nested `context.active()` read
sees the un-scoped root context, not just one across an await — a stronger requirement than ADR
0022's own note (which only documented the across-await half). `src/test/setup-otel-context.ts`
registers `AsyncLocalStorageContextManager` globally for the `unit` and `db` Vitest projects, the
same manager `@vercel/otel`'s `registerOTel()` registers in every real Next.js runtime.

**A streaming route cannot let `withRoute.ts` record its own round-trip count.** `/api/generate`'s
handler promise resolves as soon as it returns `new Response(stream, ...)` — the `ReadableStream`'s
`start()` callback keeps running, and keeps making database calls (`insertAIParagraph`,
`insertGenerationEvent`), long after that. Recording the count from `withRoute`'s own `finally`
would capture only the pre-stream round trips and silently under-report the total — exactly the
"six round trips" figure this plan exists to make visible. `withRoute`'s `selfReportsRoundtrips`
option lets a streaming route opt out of the automatic recording and report the number itself, once,
from its own true completion point (`generate/route.ts`'s `finish()`, which already runs after
every database call the request will ever make); the context-propagated counter keeps accumulating
correctly regardless of which side eventually reads it.

**`db/tracing.ts` deliberately never times a statement's actual resolution, and that's a safety
decision, not an oversight.** Drizzle's `select`/`insert`/`update` return a lazy `QueryPromise`
whose `.then()` re-executes `this.execute()` on every call — it does not memoize. A wrapper that
attached its own `.then()` observer to measure a statement's real duration would risk a second,
independent execution of whatever `insert`/`update` it wrapped: a duplicate write, not a rounding
error. Each span here starts and ends synchronously at the call itself — marking that the statement
was issued, in order, with its shape, correctly nested under the request's span — rather than
enclosing the network round trip's own duration. Overall latency stays visible on the parent
`http.route` span; the round-trip *count*, the number this plan is actually trying to surface, is
exact either way. `db.statement` is never a bound value by construction, not by discipline: the
four wrapped methods are only ever intercepted at their *top-level* call, before a caller chains
`.from()`/`.where()`/`.values()` onto the return value, so the bound values a query eventually
carries — story prose included — are never passed as an argument to this Proxy's trap in the first
place. `execute()`'s raw-SQL argument is the one exception worth naming: Drizzle's `sql` template
embeds interpolated values inside the `SQL` object itself, so `describeStatement` never inspects
it — `execute` always gets the fixed label `"execute(...)"`.

**`db/tracing.ts` composes with `bench/roundtrips.ts`'s existing Proxy rather than becoming a third
implementation of the same interception.** `db/client.ts`'s `getDb()` now constructs
`wrapWithTracing(BENCH_INSTRUMENTATION === "1" ? getRoundtripCounter().wrap(raw) : raw)` — two
Proxies nested around the same target. Safe specifically because `RoundtripCounter.wrap()`
forwards every counted call through unchanged (same arguments, same return value, same thrown
errors), so nesting a second Proxy with the same guarantee around it changes nothing about what
either wrapper observes.

**`withRoute.ts` must rebuild, not mutate, a `Response.redirect()`'s headers — found by the test
suite, not assumed correct.** A `Response` produced by `Response.redirect()` (used by two auth
routes) has an *immutable* `Headers` guard per the Fetch spec; calling `.set("x-request-id", ...)`
on it throws `TypeError: immutable`. This surfaced as four failing `route.db.test.ts` tests for
`/api/auth/verify/[token]`, not as a design review catching it in advance — the same "a real bug,
found by the test suite" shape ADR 0022 already modeled for its own span-ordering bug.
`withRequestId` now tries the in-place `.set()` first and, only on a thrown error, rebuilds a new
`Response` with a mutable copy of the same headers — general enough to cover `Response.error()`'s
identical guard too, without every route needing to know or care about the distinction.

**Why RUM is a first-party `/api/telemetry` endpoint, never a vendor SDK.** No third-party script
(ADR 0024's CSP would have to loosen to allow one), no PII leaving the app, and the same OTLP
pipeline as every server-side metric. `WebVitals.tsx` follows Next's own documented pattern (a
dedicated client component the root layout mounts, confining `useReportWebVitals`'s `"use client"`
boundary to one file) and forwards only the four vitals this app tracks (LCP, INP, CLS, TTFB) —
`useReportWebVitals` also reports FCP and Next's own hydration/render timings, silently dropped
rather than given a bucket this plan never asked for.

**Why `error.digest` only, never the message or stack.** A client render error's message can embed
on-screen user text (a story paragraph, a typed field) that was visible when rendering broke;
`digest` is Next's own opaque per-error id, safe by construction. `reportClientError.ts` is the one
function every error boundary (`error.tsx`, `global-error.tsx`, and the four segment-level
boundaries) calls, so this guarantee lives in one place rather than six.

**`/api/telemetry` treats its own body as hostile — cardinality limits matter here more than
anywhere else, because the caller is untrusted, not just untracked.** It is public and
unauthenticated by necessity (a page's client bundle has no session before one exists). Every
field is checked against a closed shape before anything is recorded; an unlisted vital name, a
wrong field type, or an unrecognized `kind` is rejected outright. Critically, `route` is never
trusted verbatim as a metric attribute even once shape-valid: `normalizeClientRoute.ts` buckets an
arbitrary client-reported pathname into one of this app's own known page templates (mirroring
`docs/architecture.md`'s page list), collapsing anything else to `"other"` — otherwise any caller
could mint unbounded time series just by POSTing distinct route strings, the exact failure mode the
plan's cardinality warning is about, applied to an attribute *value* rather than an instrument
*name*. `guardTelemetry` fails closed (unlike `guardHealth`) — a telemetry spike during a database
blip is exactly the kind of unbounded write this guard exists to bound, not a condition worth
relaxing for.

**Sampling exists on exactly one event, and the mechanism makes "errors are never sampled"
structural rather than a convention.** `log.info`'s optional `sampleRate` parameter does not exist
on `log.warn`/`log.error` at all — there is no argument position to pass a rate to, so a call site
cannot sample an error even by mistake. `GENERATE_STARTED`/`_COMPLETED`/`_FAILED`/`_CANCELLED` are
not sampled; only `GENERATE_FIRST_CHUNK` (the plan's own named example, a high-volume, non-error
event emitted once per generation regardless of outcome) is, via
`LOG_SAMPLE_RATE_GENERATE_FIRST_CHUNK`, defaulting to full (1) and parsed with the same
parse-or-fall-back-sanely pattern `policy.ts`'s `trustedProxyHopCount` already uses.

**Why SLOs live in code with a SQL report, and what `generation_event` was ultimately for.**
`slo.ts` defines four operational targets (generation success rate, TTFT p95, feed-read p95,
availability), each with a target, a window, and a one-line rationale — "vague targets are worse
than none," per the plan. Only two are computable from `generation_event` today (success rate,
TTFT p95); feed-read p95 and availability live only in OTel metrics this app doesn't query back.
`scripts/slo-report.mts` says so plainly for the other two — "not computable from
generation_event; needs OTel metric data" — rather than fabricating a number or silently omitting
the target. This is the first query ever written against `generation_event` for the purpose ADR
0022 built it for: a durable, SQL-queryable answer to "did we meet our own targets," as opposed to
sampled, expiring trace data.

**The four SLO targets are a stated, provisional judgment call — not a measurement — and that
distinction is itself the point.** This app has no production traffic history, the same gap ADR
0023 named when it first declined circuit breaking and `circuitBreaker.ts`'s own
`FAILURE_THRESHOLD` comment still names today. `bench/BASELINE.md` (Plan 1) explicitly disclaims
itself for exactly this use — "use these numbers to compare before/after a change measured the
same way, not as a production SLO" — and its TTFT figures were measured against the *mock*
provider under local Postgres, not a real model's latency over Neon's managed endpoint. Rather than
dressing up an invented number with false precision, each target's rationale says so honestly and
points at what would replace it: real production or live-provider data.

**`percentile`/`rate`, and every SLO attainment function, return `undefined` for an empty window —
never `0` or `100%`.** "No attempts in the window" and "0% success"/"a perfect p95 of nothing" are
different facts; collapsing them would silently misreport a quiet period as either an outage or a
guarantee neither happened.

**Two Vitest config files needed the `@` path alias added, discovered by running the suites, not
by code review.** `src/test/setup-otel-context.ts` had to be added to both
`vitest.unit.config.mts`'s and `vitest.db.config.mts`'s `setupFiles`. `vitest.scripts.config.mts`
had never needed the alias before — every existing script's own `@/`-prefixed import was a
*type-only* import (stripped entirely at compile time, needing no runtime resolution);
`scripts/slo-report.mts`'s transitive dependency on `db/tracing.ts`'s *value* import of
`requestContext.ts` was the first real one, and surfaced as `scripts/slo-report.test.mts` failing
to even load until the alias was added.

**A local collector stack, not just Jaeger.** `README.md`'s local-development loop grows from
Jaeger alone to a full `docker-compose` stack (OTel Collector, Prometheus, Grafana, Jaeger) — "the
same reasoning that put the Jaeger instructions in the README originally," per the plan: metrics
you cannot look at are not observability.

**A false lead worth recording so it isn't repeated: repeated local verification runs against a
long-lived Redis container produced a misleading "regression."** While reproducing this plan's own
"bring up the local stack, run `npm run bench`... confirm by eye" verification, the full `db`
Vitest project's password-reset/request tests began failing with 429s that had nothing to do with
this plan's code. Diagnosed by direct reproduction, not assumed: running the same two files in
isolation against a freshly `FLUSHALL`'d Redis passed cleanly every time; running the *entire* 76
file suite together, with real `KV_REST_API_URL` configured, intermittently did not, and a parallel
run of the same suite against a clean `main` checkout (via `git worktree`) also passed cleanly.
The actual cause: `consumeToken` tries Redis before Postgres whenever `hasKv()` is true, the `db`
Vitest project's own `beforeEach` truncates Postgres before every test but — per ADR 0035's own
documented constraint — never flushes Redis (parallel workers share one instance, and a blanket
flush would corrupt another worker's in-progress state), and dozens of manual re-runs across one
long working session, against one long-lived local `serverless-redis-http` container, slowly
exhausted real token buckets that a single clean run never would. `docker restart` alone does not
clear this — the container's persisted RDB snapshot reloads on start; only an explicit `FLUSHALL`
does. Not a code defect, and not "fixed" by changing application code — recorded here per AGENTS.md's
own instruction not to ship an unverified "shouldn't hurt" change, and because the diagnosis path
(reproduce in isolation, then reproduce the full suite, then compare against a clean `main`) is the
same discipline this repo already requires for e2e flakiness, generalized to a `db`-suite
concurrency edge the existing docs hadn't named for local dev.

## Consequences

Every route under `src/app/api/**` now produces an `http.route` span (with `http.status_code` and a
resolved `fabula.request_id`) and, for streaming routes, correctly nests the richer span that
already existed (`fabula.generate`) as a child rather than flattening it — verified directly via
`withRoute.test.ts`'s parent/child span-id assertion, not just by code inspection. Every database
call issued while handling a request appears as a same-shaped `db.*` child span, and the request's
total round-trip count is recorded once, correctly, even for a streaming route whose database calls
outlive its own handler promise. Fourteen new OTel metric instruments exist, each written to only
through a bounded, typed recorder function. Web Vitals and client errors reach the same OTLP
pipeline as every server metric, with no vendor script and no PII. Four operational targets exist
as code, honestly split between what `generation_event` can answer today and what still needs a
metrics backend this app doesn't query back — and `scripts/slo-report.mts` is the first thing to
ever read `generation_event` for the purpose it was built for.

The maintenance cost: fourteen metric instruments are fourteen more things a dashboard has to be
built against, none of which exist yet (deploying a collector, dashboards, or alert routing is
explicitly out of scope for this plan — that's hosting, not application code). The four SLO targets
are stated as provisional and will need real revisiting once production or live-provider traffic
exists; shipping them un-revisited past that point would make the honesty of this ADR's own framing
worthless. `db/tracing.ts`'s spans measure statement issuance, not statement duration — a
deliberate, disclosed trade-off against the correctness risk of double-executing a write, not a gap
to "fix" later without re-deriving why it's there.

## Rejected

- **A callback-based or `.then()`-observing design for `db/tracing.ts`**, to get accurate
  per-statement timing — rejected because Drizzle's `QueryPromise.then()` re-executes the
  underlying statement on every call rather than memoizing; observing resolution independently of
  the caller's own single await would risk a duplicate write. See above.
- **Splitting `fabula.auth.login` into `bad_password`/`unknown_user`**, as the plan originally
  specified — rejected because it reopens the account-enumeration channel `authorize.ts`'s
  dummy-hash comparison exists to close, through a channel clearer than response timing ever was.
  Confirmed with the user directly rather than resolved unilaterally either way.
- **Widening `proxy.ts`'s `config.matcher` to include `/api/**`**, so a single request-id-minting
  site could cover both pages and API routes — rejected because it would run `auth()` and CSP nonce
  construction on every API call, a real behavior and performance change to an already-tested
  subsystem (ADR 0024), for a benefit `withRoute.ts` already fully provides on its own.
- **Module-scope instrument creation for metrics**, matching `route.ts`'s tracer — rejected once
  `@opentelemetry/api`'s Metrics API was found to have no `ProxyTracerProvider`-equivalent; would
  have silently bound every instrument to the no-op meter forever if anything raced
  `instrumentation.ts`'s registration.
