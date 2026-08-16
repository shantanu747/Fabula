# Plan 3 — OpenTelemetry observability, token accounting, and health

**Branch:** `feature/otel-observability`
**Depends on:** nothing hard. Land before Plan 4 — both widen the provider contract, and doing
them in this order means one migration of the interface rather than two.
**ADR:** required.

## Why this exists

The entire observability story is nine `console.*` calls. Nothing records how long a
generation took, how many tokens it burned, what it cost, or whether it succeeded. For an
application whose core operation is a paid, streaming, third-party call, that is the gap.

Time-to-first-token is the metric the whole streaming architecture (ADR 0003) exists to
optimise, and it has never been measured.

## What "done" means

- Every request carries a request id, and every log line is structured JSON correlated to a
  trace.
- Every generation produces one span with provider, model, token counts, cost, TTFT, and
  outcome.
- Traces export over OTLP to any collector, configured entirely by standard env vars — no code
  change to switch backends.
- `GET /api/health` reports app, database, and provider-configuration status.
- No prompt text, story text, email address, or raw IP appears in any log line or span
  attribute.

## Dependencies to add

Per `node_modules/next/dist/docs/01-app/02-guides/open-telemetry.md` (read it before starting):

```
@vercel/otel @opentelemetry/api @opentelemetry/sdk-logs @opentelemetry/api-logs @opentelemetry/instrumentation
```

`@vercel/otel` is a thin configuration wrapper over the standard OTel SDK that exports OTLP and
works on both the Node and Edge runtimes — it is vendor-neutral despite the package name, and
`proxy.ts` runs on Edge where the bare `NodeSDK` does not work. The manual `NodeSDK` path in the
same doc is the fallback if `@vercel/otel` ever constrains you; note in the ADR that the
migration is confined to `src/instrumentation.ts`.

## Files

### `src/instrumentation.ts` (new — must be in `src/`, not `src/app/`)

```ts
import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "fabula" });
}
```

Next calls `register()` once per server instance, in every runtime. Confirm the file location
against the bundled instrumentation guide — placing it under `src/app/` silently does nothing.

### `src/lib/observability/logger.ts` (new)

A structured logger, not a wrapper that reformats strings.

```ts
log.info("generate.started", { requestId, providerId, storyId, authenticated });
```

Emits one JSON object per line to stdout: `{ ts, level, event, traceId, spanId, requestId,
...fields }`. `traceId`/`spanId` come from `trace.getActiveSpan()?.spanContext()` when a span is
active, and are omitted when one isn't — never fabricated.

Event names are dotted and stable (`generate.started`, `generate.first_chunk`,
`generate.completed`, `generate.failed`, `generate.cancelled`, `persist.superseded`,
`persist.failed`, `ratelimit.rejected`, `register.rejected`). Define them as a const object so
they can't drift by typo.

**A redaction allowlist, not a denylist.** The logger accepts only a declared set of field
names; anything else is dropped with a `logger.unknown_field` warning. This is what makes it
structurally impossible to log a story paragraph, and it must have a test.

Replace all nine existing `console.*` calls in `src/app/api/generate/route.ts` and
`src/lib/story/streamGeneration.ts`. The one in `streamGeneration.ts` runs in the browser —
either give the logger a browser-safe path or leave that single call as `console.error` with a
comment. Do not import the server logger into a `"use client"` module.

### `src/lib/observability/requestId.ts` (new)

`resolveRequestId(request: Request): string` — honour an inbound `x-request-id` when it is a
sane shape (length ≤ 128, `[A-Za-z0-9._-]+`), otherwise mint a UUID. **Validate it**; an
unvalidated header echoed into logs is a log-injection vector.

Every API route sets `x-request-id` on its response, including error responses and the
streaming one.

### `src/lib/providers/pricing.ts` (new)

```ts
export interface ModelPricing { inputPerMTok: number; outputPerMTok: number }
export const PRICING: Record<string, ModelPricing> = { … }
export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined
```

Seed from the figures already recorded in the adapter comments: `gpt-5-mini` $0.25/$2.00,
`meta-llama/llama-3.3-70b-instruct` $0.10/$0.32; look up `claude-sonnet-5` rather than guessing,
and cite the source in a comment next to each entry with the date checked. An unknown model
returns `undefined` — never zero, which would silently under-report.

This is a pure function under `src/lib/providers/`; the coverage config holds
`prompt,registry,list,constants,types` at 100% by name, so `pricing.ts` falls under no explicit
tier and lands in the global bucket. Add it to the 100% tier list in `vitest.config.mts` — cost
arithmetic is exactly the kind of thing that should never regress — and test the boundaries,
including the unknown-model case.

### Provider contract change — the substantial part

Token usage is currently discarded. Widening the generator's return value is the honest fix.

`src/lib/providers/types.ts`:

```ts
export interface TokenUsage { inputTokens: number; outputTokens: number }

export interface GenerationResult {
  /** UC-3's invented theme/characters. Was previously the whole return value. */
  invented?: InventedMetadata;
  usage?: TokenUsage;
  /** The concrete model id the adapter used, for cost lookup and drift detection. */
  model: string;
}

generateParagraph(input: GenerateParagraphInput): AsyncGenerator<string, GenerationResult, unknown>
```

Threading it through:

- `prompt.ts`'s `rawTextStream` parameter type becomes
  `(input, trueCount) => AsyncGenerator<string, ProviderTurnInfo | undefined>` where
  `ProviderTurnInfo = { usage?: TokenUsage; model: string }`.
- `extractInventedMetadata` keeps returning `InventedMetadata | undefined` — do **not** entangle
  it with usage. Instead it must now propagate the inner generator's return value, which means
  driving the inner stream with `.next()` rather than `for await…of` (the latter discards
  returns — this is the exact subtlety `prompt.sentinel.test.ts` already documents). Change it
  carefully and extend the property tests.
- `generateWithProvider` combines both into a `GenerationResult`.
- Anthropic: `stream.finalMessage()` is already awaited; read `usage.input_tokens` and
  `usage.output_tokens` from it.
- OpenAI and OpenRouter: add `stream_options: { include_usage: true }` to
  `chat.completions.create`. The usage arrives on a final chunk whose `choices` array is empty —
  the existing loop already skips it safely, but you must capture it before returning. Verify
  OpenRouter actually honours `include_usage`; if it doesn't, return `usage: undefined` and log
  once at startup rather than fabricating numbers.

Update `AGENTS.md`'s inlined `LLMProvider` snippet to match. That block is normative and a
stale copy is worse than none.

### `src/app/api/generate/route.ts`

Wrap the generation in a span named `fabula.generate` with attributes following OTel GenAI
semantic conventions where they exist:

| Attribute | Value |
|---|---|
| `gen_ai.system` | provider id |
| `gen_ai.request.model` | model id from `GenerationResult` |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | from usage |
| `fabula.ttft_ms` | ms from request receipt to the first chunk resolving |
| `fabula.total_ms` | ms to stream completion |
| `fabula.cost_usd` | from `estimateCostUsd` |
| `fabula.outcome` | `success` \| `provider_error` \| `cancelled` \| `persist_failed` |
| `fabula.persisted` | boolean |
| `fabula.authenticated` | boolean |
| `fabula.story_id` | story id, or absent for guests |
| `fabula.paragraph_count` | `storySoFar.length` |

Never set an attribute containing prose, a theme, a character list, an email, or an IP.

**The span-lifetime trap.** The route returns its `Response` before the stream finishes. The
span must be ended in three places — the `done` branch of `start()`, the `done` branch of
`pull()`, and `cancel()` — and on the error path in `pull()`'s catch with
`span.setStatus({ code: SpanStatusCode.ERROR })`. Missing one leaks a span that never exports.
Use `context.with(trace.setSpan(...))` so the async stream callbacks still see the active span;
they run outside the request's synchronous context and will otherwise attach to nothing.

Write a test that asserts exactly one span is ended per generation, across the success,
mid-stream-error, and cancellation paths. Use an in-memory span exporter
(`@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter`) — this is the single most valuable
test in the plan.

TTFT is measured at the moment `first = await iterator.next()` resolves in the route, which is
already a distinct step. Record it there.

### `src/app/api/health/route.ts` (new)

```
GET /api/health -> 200 { status: "ok", version, uptimeSeconds, checks: { database, providers } }
                -> 503 { status: "degraded", … }
```

- `database`: `"ok"` | `"unreachable"` | `"not-configured"`. Use `hasDatabase()` from
  `src/lib/db/client.ts` first, then a `SELECT 1` bounded by a ~2s timeout. Not-configured is
  **not** a 503 — guest writing works without a database by design (ADR 0009), so a missing
  `DATABASE_URL` is a valid deployment.
- `providers`: for each registry entry, whether its API key env var is a non-empty string.
  Report ids and a boolean only — never key prefixes, lengths, or values.
- `version`: `process.env.VERCEL_GIT_COMMIT_SHA ?? "dev"`.
- `Cache-Control: no-store`, and `export const dynamic = "force-dynamic"`.
- Unauthenticated by design (it must work when auth is broken), which is why it carries nothing
  sensitive. Rate-limit it with a new cheap policy in `src/lib/ratelimit/policy.ts` — that file
  is at 100% coverage, so the new policy needs a test.

## Configuration

`.env.example` and `README.md` gain:

```
# OpenTelemetry — standard OTLP env vars, no code change needed to switch backends.
# Unset means no exporter is configured and instrumentation is inert.
OTEL_SERVICE_NAME=fabula
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_EXPORTER_OTLP_HEADERS=
```

Document the local verification loop in `README.md`, because "vendor-neutral OTel" with nothing
to look at is not observability:

```bash
docker run -d --name fabula-jaeger -p 16686:16686 -p 4318:4318 \
  jaegertracing/all-in-one:latest
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
# then write a paragraph and open http://localhost:16686
```

Confirm by hand that a `fabula.generate` span appears with token counts and TTFT populated,
and say in the PR that you did.

## Tests

- `logger.test.ts` — allowlist drops an undeclared field; trace ids appear when a span is
  active and are absent when not; output is valid JSON per line; a field containing a newline
  cannot break the line format.
- `requestId.test.ts` — an over-long, or control-character-bearing, or empty inbound header is
  rejected and replaced; a valid one is preserved.
- `pricing.test.ts` — each known model, an unknown model, zero usage, and a large-usage case
  checked against hand-computed values.
- `route.test.ts` additions — span count and attributes on success, provider error, and
  cancellation, via `InMemorySpanExporter`. Assert **no** attribute value contains any of the
  story text used in the fixture; this is the privacy guarantee and it deserves a direct test.
- `health/route.test.ts` — database ok / unreachable / not-configured; no key material in the
  response body under any branch.
- Existing tests will break: `prompt.test.ts`, `prompt.sentinel.test.ts`,
  `streamGeneration.test.ts`, and both generate route suites all touch the changed return type.
  Update them as part of the change; do not weaken an assertion to make one pass.

## Optional step, only if you want it

The question that produced this plan chose OTel over a Postgres metrics table. Traces get
sampled and expire, so there will be **no SQL-queryable cost history** — you cannot ask "what
did user X cost last month." If you want that too, add a `generation_event` table plus a
migration and write one row per generation alongside the span. It is a deliberate addition, not
part of this plan's definition of done; if you skip it, name the gap in the ADR's Consequences.

## Gotchas

- `registerOTel` runs in the Edge runtime too (`proxy.ts`). Do not import `node:`-only modules
  from `instrumentation.ts`.
- `@vercel/otel` with no `OTEL_EXPORTER_OTLP_ENDPOINT` set must be a no-op, not a crash. Verify
  `npm run build` and `npm run dev` both work with the var unset — CI has it unset.
- `next build` executes module scope. Keep the logger and pricing free of side effects.
- The coverage tier for `src/app/api/generate/**` is 90/85/90/90. Adding span-management
  branches without tests will drop it below the line.
- `src/lib/db/client.ts`'s `hasDatabase()` returns true when a handle was injected for tests.
  The health route must still perform the `SELECT 1`, not trust that flag alone.
- Do not log the `x-forwarded-for` value. `src/lib/ratelimit/policy.ts` deliberately hashes
  addresses so the database isn't a record of who used the app; logging the raw header would
  undo that decision in a different place.

## Out of scope

- Metrics instruments (counters/histograms) beyond span attributes. Spans carry enough for now.
- Alerting, dashboards, or a collector deployment — that belongs with v4's hosting.
- Client-side / RUM instrumentation.
- Sentry or any error-tracking vendor.

## ADR

`docs/adr/00NN-observability-and-cost-accounting.md`. Cover:

- Why OTel over a vendor SDK, and why `@vercel/otel` is still vendor-neutral.
- Why the provider contract had to widen, and why usage rides the generator's return value
  rather than a side-channel callback (the return value is already the established mechanism
  for out-of-band data — ADR 0003 — and a callback would make the interface stateful).
- The privacy line: what may and may not become a log field or span attribute, and why the
  allowlist is structural rather than a review convention.
- Why `/api/health` treats an absent database as healthy.
- The named gap: no durable cost history without the optional table.
