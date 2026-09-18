import { metrics, type Attributes, type Counter, type Histogram, type MetricOptions, type UpDownCounter } from "@opentelemetry/api";

/**
 * OTel metric instruments, exported over OTLP by the `MeterProvider`
 * `src/instrumentation.ts` registers alongside the existing trace provider —
 * same backend-agnostic property ADR 0022 established for traces (docs/adr/0049).
 *
 * **Every instrument below is created lazily, on first use — not at module
 * scope.** This is not just the "safe at `next build`'s module-evaluation
 * time" property `route.ts`'s module-scope `tracer` already has; it is a
 * *different and stricter* requirement, found by reading
 * `@opentelemetry/api`'s own source rather than assuming symmetry with
 * tracing: `trace.getTracer()` is backed by a `ProxyTracerProvider` that
 * resolves its real delegate lazily, so registering a real `TracerProvider`
 * *after* a tracer was already obtained still works retroactively. The
 * Metrics API has no such proxy — `metrics.getMeter()` calls
 * `getMeterProvider().getMeter()` directly and permanently binds to
 * whichever provider is registered *at that exact call*. A histogram
 * created from a meter obtained before `instrumentation.ts`'s `register()`
 * finishes would be a real, no-op-forever instrument — silently recording
 * nothing, with no error, ever again, even after the real provider is
 * registered a moment later. Deferring both the meter lookup and the
 * instrument creation to a recorder function's first actual call (which,
 * for every function below, only ever happens from inside a request
 * handler — i.e. after Next's own documented guarantee that `register()`
 * "must complete before the server is ready to handle requests") is what
 * makes this correct regardless of module import order.
 *
 * With no `OTEL_EXPORTER_OTLP_ENDPOINT` configured, `instrumentation.ts`
 * never calls `metrics.setGlobalMeterProvider()`, so every instrument below
 * resolves against `@opentelemetry/api`'s built-in no-op meter and every
 * recorder is a silent, side-effect-free no-op — never a crash.
 *
 * Every recorder function below takes only bounded enum-shaped parameters,
 * never a free string. A user id, story id, request id, or raw message must
 * never become a metric attribute — unlike a span or a log line, a metric
 * attribute multiplies the number of stored time series, so an unbounded
 * value here is the mistake that makes an observability bill exceed a
 * hosting bill (docs/adr/0049). This module is the metrics equivalent of
 * `logger.ts`'s redaction allowlist: the *only* way to write to an
 * instrument is through one of these typed functions, so a high-cardinality
 * attribute is a compile error, not a review miss.
 */

function lazyHistogram(name: string, options: MetricOptions): (value: number, attrs: Attributes) => void {
  let instrument: Histogram | undefined;
  return (value, attrs) => {
    if (!instrument) instrument = metrics.getMeter("fabula").createHistogram(name, options);
    instrument.record(value, attrs);
  };
}

function lazyCounter(name: string, options: MetricOptions): (attrs: Attributes) => void {
  let instrument: Counter | undefined;
  return (attrs) => {
    if (!instrument) instrument = metrics.getMeter("fabula").createCounter(name, options);
    instrument.add(1, attrs);
  };
}

function lazyUpDownCounter(name: string, options: MetricOptions): (delta: number) => void {
  let instrument: UpDownCounter | undefined;
  return (delta) => {
    if (!instrument) instrument = metrics.getMeter("fabula").createUpDownCounter(name, options);
    instrument.add(delta);
  };
}

export type GenerationOutcome = "success" | "provider_error" | "cancelled" | "persist_failed";
export type TokenKind = "input" | "output" | "cache_read" | "cache_write";
export type AdmissionReason = "per_user" | "global";
export type BudgetScope = "user" | "global" | "guest";
export type CircuitTransition = "opened" | "closed" | "probe_allowed";
export type CacheResult = "hit" | "write" | "miss";
export type ResumeResult = "resumed" | "not_found" | "timed_out";
/**
 * Deliberately does NOT distinguish "no such account" from "wrong password" —
 * see `authorize.ts`'s dummy-hash comparison. Splitting this into
 * `unknown_user` / `bad_password`, as an earlier draft of this metric
 * proposed, would reopen exactly the account-enumeration channel that
 * comparison exists to close, through a clearer signal than response timing
 * ever was: an attacker could watch which bucket increments after a guessed
 * login and learn account existence in one read, no statistics needed.
 */
export type LoginResult = "success" | "invalid_credentials" | "rate_limited";

const generationTtft = lazyHistogram("fabula.generation.ttft", {
  description: "Time to first token for a generation.",
  unit: "ms",
});
const generationDuration = lazyHistogram("fabula.generation.duration", {
  description: "Total wall-clock duration of a generation.",
  unit: "ms",
});
const generationTokens = lazyHistogram("fabula.generation.tokens", {
  description: "Token count for one generation, by kind (input/output/cache_read/cache_write).",
  unit: "tokens",
});
const generationCostUsd = lazyHistogram("fabula.generation.cost_usd", {
  description: "Estimated cost of one generation.",
  unit: "usd",
});
const generationOutcome = lazyCounter("fabula.generation.outcome", {
  description: "Generations completed, by terminal outcome.",
});
const generationInFlight = lazyUpDownCounter("fabula.generation.in_flight", {
  description: "Generations currently in flight.",
});
const ratelimitRejected = lazyCounter("fabula.ratelimit.rejected", {
  description: "Requests rejected by a rate-limit policy.",
});
const admissionRejected = lazyCounter("fabula.admission.rejected", {
  description: "Generations refused by admission control.",
});
const budgetExceeded = lazyCounter("fabula.budget.exceeded", {
  description: "Generations refused by a daily spend cap.",
});
const providerCircuit = lazyCounter("fabula.provider.circuit", {
  description: "Provider circuit-breaker state transitions.",
});
const cachePrompt = lazyCounter("fabula.cache.prompt", {
  description: "Provider-side prompt cache outcomes, derived from reported token usage.",
});
const streamResume = lazyCounter("fabula.stream.resume", {
  description: "Resume attempts against a dropped generation stream.",
});
const authLogin = lazyCounter("fabula.auth.login", {
  description: "Credentials-provider login attempts, by result.",
});
const dbRoundtrips = lazyHistogram("fabula.db.roundtrips", {
  description: "Database round trips issued while handling one request.",
});
const clientVital = lazyHistogram("fabula.client.vital", {
  description: "Web Vitals (LCP/INP/CLS/TTFB) reported by real clients via /api/telemetry.",
});
const clientError = lazyCounter("fabula.client.error", {
  description: "Client-side render/boundary errors reported via /api/telemetry.",
});

export function recordGenerationTtft(
  ms: number,
  attrs: { provider: string; model: string; authenticated: boolean }
): void {
  generationTtft(ms, attrs);
}

export function recordGenerationDuration(ms: number, attrs: { provider: string; outcome: GenerationOutcome }): void {
  generationDuration(ms, attrs);
}

export function recordGenerationTokens(count: number, attrs: { provider: string; kind: TokenKind }): void {
  if (count <= 0) return;
  generationTokens(count, attrs);
}

export function recordGenerationCostUsd(usd: number, attrs: { provider: string; model: string }): void {
  generationCostUsd(usd, attrs);
}

export function recordGenerationOutcome(attrs: { provider: string; outcome: GenerationOutcome }): void {
  generationOutcome(attrs);
}

export function generationStarted(): void {
  generationInFlight(1);
}

export function generationEnded(): void {
  generationInFlight(-1);
}

export function recordRatelimitRejected(policy: string): void {
  ratelimitRejected({ policy });
}

export function recordAdmissionRejected(reason: AdmissionReason): void {
  admissionRejected({ reason });
}

export function recordBudgetExceeded(scope: BudgetScope): void {
  budgetExceeded({ scope });
}

export function recordProviderCircuit(provider: string, transition: CircuitTransition): void {
  providerCircuit({ provider, transition });
}

export function recordCachePrompt(provider: string, result: CacheResult): void {
  cachePrompt({ provider, result });
}

export function recordStreamResume(result: ResumeResult): void {
  streamResume({ result });
}

export function recordAuthLogin(result: LoginResult): void {
  authLogin({ result });
}

export function recordDbRoundtrips(count: number, route: string): void {
  dbRoundtrips(count, { route });
}

/** `name`/`route` only — both already bounded (a fixed vital name, a
 *  normalized page template, see normalizeClientRoute.ts) — never the raw
 *  client-reported route string, and never anything else off the request
 *  body. */
export function recordClientVital(name: string, value: number, route: string): void {
  clientVital(value, { name, route });
}

export function recordClientError(route: string): void {
  clientError({ route });
}

/**
 * Derives a `fabula.cache.prompt` outcome from a generation's reported token
 * usage — there is no separate cache module to observe (docs/adr/0040's
 * "prompt caching" is the *provider's* cache, windowed into by
 * `stable-prefix` construction; Fabula only ever sees it through
 * `cacheReadInputTokens`/`cacheCreationInputTokens`). A single call can
 * report both a read and a write (a cached prefix hit plus a new suffix
 * cached in the same turn), so this may record up to two outcomes rather
 * than forcing a single mutually-exclusive bucket.
 */
export function recordCachePromptFromUsage(
  providerId: string,
  usage: { cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined
): void {
  if (!usage) return;
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  if (read > 0) recordCachePrompt(providerId, "hit");
  if (write > 0) recordCachePrompt(providerId, "write");
  if (read === 0 && write === 0) recordCachePrompt(providerId, "miss");
}
