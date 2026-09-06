# 22. Observability, structured logging, and cost accounting

## Status

Accepted.

## Context

Before this change, the entire observability story was nine bare `console.*` calls across
`route.ts` and `guard.ts`. Nothing recorded how long a generation took, how many tokens it
burned, what it cost, or whether it succeeded — for an app whose core operation is a paid,
streaming, third-party call, that's the gap. Time-to-first-token is specifically the metric the
streaming architecture (ADR 0003) exists to optimise, and it had never been measured.

Spec: `docs/plans/v3/03-otel-observability.md`.

## Decision

**OTel over a vendor SDK, and why `@vercel/otel` is still vendor-neutral.** A vendor-specific
APM SDK would tie every trace to one backend's data model and pricing; OpenTelemetry exports
over the standard OTLP protocol to any collector (Jaeger, Honeycomb, Datadog, ...), so switching
backends is an env-var change, not a code change. `@vercel/otel` (package name notwithstanding)
is a thin configuration wrapper over the standard OTel SDK, not a Vercel-specific telemetry
product — it works on both the Node and Edge runtimes, which matters because `proxy.ts` runs on
Edge where the bare `NodeSDK` does not. `src/instrumentation.ts` is the single point of contact
with the SDK; if `@vercel/otel` ever needs replacing with the manual `NodeSDK` path, that
migration is confined to this one file.

**Why usage rides the generator's return value rather than a side-channel callback.** The
provider contract widened from `AsyncGenerator<string, InventedMetadata | undefined>` to
`AsyncGenerator<string, GenerationResult, unknown>`, where `GenerationResult` bundles the
invented theme/characters (already there, UC-3) with token usage and the resolved model id. The
alternative — an `onUsage(usage)` callback passed into `generateParagraph` — was rejected: the
return value is already the established mechanism this codebase uses for out-of-band data from
a generator (ADR 0003), and a callback would make the interface stateful (a provider adapter
would need to remember to call it, and at the right time) where the return value is structurally
guaranteed to arrive exactly once, at completion.

Threading this through required `extractInventedMetadata` (`src/lib/providers/prompt.ts`) to
change how it drives its inner stream. It used to consume `rawStream` with `for await…of`, which
discards whatever the inner generator returns — the same subtlety `prompt.sentinel.test.ts`
already existed to document for the metadata-parsing path. It now drives `rawStream` with a
manual `.next()` loop (or, for the pure-passthrough branch, `yield*`, which forwards yields *and*
evaluates to the inner return value — the same effect, less code, no state to carry across
iterations by hand) so the raw stream's `ProviderTurnInfo` return isn't thrown away. Its own
return value widens from `InventedMetadata | undefined` to `{ metadata, raw }` — a generic pair
type parameterised over whatever the inner stream returns, which is `void` for the eval
harness's plain chunk streams and `ProviderTurnInfo` for a real adapter. `generateWithProvider`
stopped being a bare passthrough and became a small wrapper (`combineResult`) that drives
`extractInventedMetadata` the same way and reshapes `{ metadata, raw }` into the public
`GenerationResult`.

This interface change had a wider blast radius than the plan's own file list named: two files
in `evals/` (`record.ts`'s `extractProse`, `replay.ts`'s `replayFixture`) and
`test-support/mock-provider/server.test.ts` all drive `generateParagraph` or
`extractInventedMetadata` directly and read the old return shape — all three needed updating
alongside the interface (`value.invented` / `value.metadata` instead of `value` directly). None
of the 29 committed eval fixtures needed re-recording: `stream_options: { include_usage: true }`
is a request-shape addition on the live adapter call, but the mock server replays a fixture's
raw SSE verbatim regardless of what the request asked for, so replay is unaffected.

**The privacy line is structural, not a review convention.** `src/lib/observability/logger.ts`
accepts only an explicit allowlist of field names; anything else is dropped with a
`logger.unknown_field` warning rather than passed through. This is what makes it *impossible*,
not just discouraged, for a log call to leak a story paragraph, a prompt, an email, or a raw IP
— the mistake has to be caught by the type of thing being logged, not by a reviewer noticing an
unusual field name in a diff. The same reasoning extends to span attributes in `route.ts`: only
ids, counts, booleans, and numbers, verified directly in `route.test.ts` by asserting no
attribute value contains the test fixture's story text. `requestId.ts` applies the same
discipline in the other direction — an inbound `x-request-id` header is validated
(`[A-Za-z0-9._-]{1,128}`) before it's ever echoed into a log line or response header, because an
unvalidated header is a log-injection vector.

**Why `/api/health` treats an absent database as healthy.** Guest writing has never required a
database (ADR 0009) — a health check that reported "degraded" on every "clone it and try the
guest flow" environment would be actively misleading. `database: "not-configured"` is a distinct,
non-503 state from `database: "unreachable"`.

**`/api/health`'s rate limiter fails open, unlike every other guarded route.** `guardGenerate`
and `guardRegister` fail *closed* on a database error — the whole point of those limits is to
bound spend, and failing open would hand an unlimited budget to anyone who can make the database
unhappy (ADR 0015). A health endpoint has no comparable budget to protect, and failing closed
here would actively defeat its purpose: a database outage is exactly the condition `/api/health`
exists to report, and a fail-closed limiter would mask that behind a generic 429 before the
health check itself ever ran. `guard.ts`'s shared `apply()` gained a `failOpen` option, used only
by the new `guardHealth`.

**The `generation_event` table exists now, not as a named future gap.** The plan itself frames a
durable cost-history table as optional — traces get sampled and expire, so without it there's no
SQL-queryable "what did user X cost last month." This was raised with the user as an explicit
choice before implementation, including whether it belonged in Postgres at all versus a separate
NoSQL store, given this is presently a portfolio project. The reasoning, worked through directly
rather than assumed:

- *Volume.* One row per AI generation, not per user action. At a generously-estimated 10,000
  users and 50 generations/user/month, that's ~500K rows/month, ~6M/year — ordinary single-table
  OLTP territory with an index on `userId`/`createdAt`, nowhere near where a relational table
  becomes the bottleneck.
- *Access pattern.* The query this table exists to answer — per-user, per-month cost rollups —
  is a textbook relational aggregation (`SUM(...) GROUP BY userId, date_trunc(...)`, potentially
  joined against `users`/`stories`). That's exactly what Postgres is for; a NoSQL store would
  need pre-aggregation or a secondary index layer to answer the same question as cheaply.
  Meanwhile, the data that genuinely is high-volume, sampled, and short-lived — raw trace spans —
  is *not* in this table at all; it's routed to an external OTLP backend, which is the
  specialised store that shape of data actually calls for.
- *Stack cost.* AGENTS.md is explicit: don't add a new package or a new infrastructure
  dependency the existing stack already covers. A second database technology for one small fact
  table is a new client library, new local/CI provisioning, and a new failure mode — real
  ongoing cost for a table this plan itself calls optional.
- *What actually signals engineering judgment.* A second datastore bolted onto a 6M-row/year
  table reads as reaching for a tool because it's available, not because the problem calls for
  it — the kind of thing a Staff-level portfolio review flags as a smell, not a strength. What
  does hold up: the OTel/OTLP work itself (real distributed tracing is a comparatively rare,
  valued skill to have actually built), and a written, quantified reason for the boring choice
  over the novel one — which this section is.

Deliberately `onDelete: "set null"` on `generation_event`'s `userId`/`storyId`, unlike every
other table's `cascade`: this table's whole purpose is durable history, and a deleted account or
story shouldn't retroactively erase what it already cost. Both columns are nullable for the same
reason every other field on this table is best-effort — guests and unsaved stories still
generate, and still cost money.

**Span lifetime.** The route returns its `Response` before the stream finishes, so the span
can't simply be ended after `return`. It's ended in the `done` branch of `start()`, the `done`
branch of `pull()`, `pull()`'s catch block (mid-stream provider error), `cancel()`, and — one
site the plan's own enumeration didn't name — the `try/catch` around the pre-fetched
`first = await iterator.next()`, before the `ReadableStream` is even constructed. Missing that
last one would leak a span on the "bad API key" / "invalid model" path, which throws before any
stream callback ever runs. `context.with(trace.setSpan(...))` wraps each stream callback so the
logger's `trace.getActiveSpan()` call resolves correctly inside them — they run outside the
route's synchronous execution context and would otherwise see no active span. (This span
threading only matters for log-line trace/span-id correlation; the span's own attributes are set
via a directly-closed-over reference, not `getActiveSpan()`, so they're correct regardless of
context propagation. That distinction mattered for testing: `@opentelemetry/api`'s
`ContextManager` is only registered by `@vercel/otel`'s `registerOTel()`, which only Next calls,
not Vitest — so `context.with()` is a no-op in a plain unit test unless a `ContextManager` is
registered for it, same as `trace.getTracer()` was found lazily-resolving in `route.test.ts`'s
own `InMemorySpanExporter` setup below.)

**A real ordering bug, found by the test suite rather than assumed correct.** The first version
of the success path called `controller.close()` before `await finish(...)` (the function that
ends the span, logs, and writes the `generation_event` row). `close()` signals "done" to the
stream's consumer immediately — it does not wait on `pull()`'s own returned promise — so a test
that awaited the full response and then ran its `afterEach` truncate could race a still-in-flight
`generation_event` insert on the same connection, producing a genuine Postgres deadlock (an
INSERT holding a lock the `TRUNCATE ... CASCADE` needed, and vice versa). This surfaced as
`src/app/api/generate/route.db.test.ts`'s "still delivers the paragraph when the mirror write
fails" test corrupting the *next* test's teardown, not itself — the kind of failure that looks
unrelated to its actual cause. Fixed by sequencing `finish()` before `controller.close()`, so
nothing server-side is still running once the client observes the stream as closed.

## Consequences

Every generation now produces one span (provider, model, token counts, cost, TTFT, total
duration, outcome, persistence status) exportable to any OTLP collector with no code change to
switch backends, one structured JSON log line per lifecycle event, and — for a logged-in
Writer or a guest, alike — one durable `generation_event` row. Verified by hand: a live
generation through the real Anthropic adapter pointed at the mock provider server produced a
`fabula.generate` span in a local Jaeger instance with `gen_ai.usage.input_tokens` = 10,
`gen_ai.usage.output_tokens` = 91, `fabula.ttft_ms` = 11, `fabula.cost_usd` = 0.00093, and a
matching `generation_event` row — the whole path, end to end.

`GET /api/health` now gives a real answer to "is this deployment usable" without needing a
database, and doesn't lie about a database outage by rate-limiting itself into silence.

The maintenance cost: `PRICING` in `src/lib/providers/pricing.ts` is a hand-maintained table that
will drift if a provider changes its pricing without a corresponding code change — each entry is
dated in a comment specifically so a stale price is visible on inspection rather than silently
wrong forever. `estimateCostUsd` returns `undefined`, never `0`, for a model it doesn't
recognise, so a pricing gap shows up as a missing `fabula.cost_usd` attribute rather than a
silently-wrong zero.

## Rejected

- **A vendor APM SDK** (Datadog, Honeycomb's native SDK, etc.) instead of OpenTelemetry — ties
  the app to one backend's data model from day one, where OTLP keeps the backend a deployment-time
  choice.
- **A callback-based usage side-channel** on `generateParagraph`, instead of widening the return
  value — see above; the return value is the existing, structurally-guaranteed mechanism this
  codebase already uses for exactly this shape of out-of-band data.
- **A NoSQL store for `generation_event`** — see above; the access pattern, volume, and existing
  stack all point at Postgres, and the high-volume data that would actually justify a different
  store (raw spans) is already routed elsewhere.
- **Failing `/api/health`'s rate limiter closed**, matching every other guarded route, for
  consistency's sake — would make the endpoint lie about the exact condition (a database outage)
  it exists to surface.
