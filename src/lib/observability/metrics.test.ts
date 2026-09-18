import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { MeterProvider, MetricReader, type CollectionResult } from "@opentelemetry/sdk-metrics";
import type * as MetricsModule from "./metrics";

/**
 * A minimal, spec-compliant MetricReader (the pattern OTel's own test suite
 * uses) — `collect()` synchronously pulls the current aggregated state, no
 * periodic export or network involved.
 */
class TestMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let reader: TestMetricReader;
let provider: MeterProvider;
let m: typeof MetricsModule;

/**
 * metrics.ts caches each instrument in a module-scope closure on first use
 * (its own doc comment explains why: production only ever registers one
 * provider, once, for the process's whole lifetime, so this caching is
 * exactly the right behavior there). A test suite that wants a fresh
 * provider per test needs a fresh copy of that module-scope cache too —
 * `vi.resetModules()` plus a dynamic re-import is what actually gets one,
 * rather than assuming provider registration alone is enough.
 */
beforeEach(async () => {
  reader = new TestMetricReader();
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  vi.resetModules();
  m = await import("./metrics");
});

afterEach(async () => {
  await provider.shutdown();
  metrics.disable();
});

async function collect(): Promise<CollectionResult> {
  return reader.collect();
}

interface FlatPoint {
  metric: string;
  value: number;
  attributes: Record<string, unknown>;
}

async function allDataPoints(): Promise<FlatPoint[]> {
  const { resourceMetrics } = await collect();
  const points: FlatPoint[] = [];
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const dp of metric.dataPoints) {
        points.push({
          metric: metric.descriptor.name,
          value: dp.value as number,
          attributes: dp.attributes,
        });
      }
    }
  }
  return points;
}

async function pointsFor(metricName: string): Promise<FlatPoint[]> {
  return (await allDataPoints()).filter((p) => p.metric === metricName);
}

describe("metrics — instruments record with expected attributes", () => {
  it("fabula.generation.ttft — histogram with provider/model/authenticated", async () => {
    m.recordGenerationTtft(420, { provider: "anthropic", model: "claude-sonnet-5", authenticated: true });

    const [point] = await pointsFor("fabula.generation.ttft");
    expect(point.attributes).toEqual({ provider: "anthropic", model: "claude-sonnet-5", authenticated: true });
  });

  it("fabula.generation.duration — histogram with provider/outcome", async () => {
    m.recordGenerationDuration(900, { provider: "openai", outcome: "success" });

    const [point] = await pointsFor("fabula.generation.duration");
    expect(point.attributes).toEqual({ provider: "openai", outcome: "success" });
  });

  it("fabula.generation.tokens — records each kind separately, skips a non-positive count", async () => {
    m.recordGenerationTokens(120, { provider: "anthropic", kind: "input" });
    m.recordGenerationTokens(0, { provider: "anthropic", kind: "cache_write" });
    m.recordGenerationTokens(-1, { provider: "anthropic", kind: "cache_read" });

    const points = await pointsFor("fabula.generation.tokens");
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ provider: "anthropic", kind: "input" });
  });

  it("fabula.generation.cost_usd — histogram with provider/model", async () => {
    m.recordGenerationCostUsd(0.0042, { provider: "anthropic", model: "claude-sonnet-5" });

    const [point] = await pointsFor("fabula.generation.cost_usd");
    expect((point.value as unknown as { sum: number }).sum).toBeCloseTo(0.0042, 10);
  });

  it("fabula.generation.outcome — counter with provider/outcome", async () => {
    m.recordGenerationOutcome({ provider: "openrouter", outcome: "provider_error" });

    const [point] = await pointsFor("fabula.generation.outcome");
    expect(point.value).toBe(1);
    expect(point.attributes).toEqual({ provider: "openrouter", outcome: "provider_error" });
  });

  it("fabula.generation.in_flight — up-down counter, net of started/ended calls", async () => {
    m.generationStarted();
    m.generationStarted();
    m.generationEnded();

    const [point] = await pointsFor("fabula.generation.in_flight");
    expect(point.value).toBe(1);
  });

  it("fabula.ratelimit.rejected — counter keyed by policy scope only", async () => {
    m.recordRatelimitRejected("generate:guest");

    const [point] = await pointsFor("fabula.ratelimit.rejected");
    expect(point.attributes).toEqual({ policy: "generate:guest" });
  });

  it("fabula.admission.rejected — counter keyed by reason", async () => {
    m.recordAdmissionRejected("global");

    const [point] = await pointsFor("fabula.admission.rejected");
    expect(point.attributes).toEqual({ reason: "global" });
  });

  it("fabula.budget.exceeded — counter keyed by scope", async () => {
    m.recordBudgetExceeded("guest");

    const [point] = await pointsFor("fabula.budget.exceeded");
    expect(point.attributes).toEqual({ scope: "guest" });
  });

  it("fabula.provider.circuit — counter keyed by provider/transition", async () => {
    m.recordProviderCircuit("anthropic", "opened");

    const [point] = await pointsFor("fabula.provider.circuit");
    expect(point.attributes).toEqual({ provider: "anthropic", transition: "opened" });
  });

  it("fabula.stream.resume — counter keyed by result", async () => {
    m.recordStreamResume("timed_out");

    const [point] = await pointsFor("fabula.stream.resume");
    expect(point.attributes).toEqual({ result: "timed_out" });
  });

  it("fabula.auth.login — counter keyed by result", async () => {
    m.recordAuthLogin("invalid_credentials");

    const [point] = await pointsFor("fabula.auth.login");
    expect(point.attributes).toEqual({ result: "invalid_credentials" });
  });

  it("fabula.db.roundtrips — histogram keyed by route", async () => {
    m.recordDbRoundtrips(6, "/api/generate");

    const [point] = await pointsFor("fabula.db.roundtrips");
    expect((point.value as unknown as { sum: number }).sum).toBe(6);
    expect(point.attributes).toEqual({ route: "/api/generate" });
  });

  it("fabula.client.vital / fabula.client.error", async () => {
    m.recordClientVital("LCP", 1800, "/story");
    m.recordClientError("/feed/[id]");

    const [vital] = await pointsFor("fabula.client.vital");
    expect(vital.attributes).toEqual({ name: "LCP", route: "/story" });
    const [err] = await pointsFor("fabula.client.error");
    expect(err.attributes).toEqual({ route: "/feed/[id]" });
  });
});

describe("instrument caching", () => {
  it("reuses the same histogram instrument across repeated calls, accumulating both", async () => {
    m.recordGenerationTtft(100, { provider: "anthropic", model: "claude-sonnet-5", authenticated: false });
    m.recordGenerationTtft(300, { provider: "anthropic", model: "claude-sonnet-5", authenticated: false });

    const [point] = await pointsFor("fabula.generation.ttft");
    const histogram = point.value as unknown as { count: number; sum: number };
    expect(histogram.count).toBe(2);
    expect(histogram.sum).toBe(400);
  });
});

describe("recordCachePromptFromUsage", () => {
  it("records a hit when cacheReadInputTokens > 0", async () => {
    m.recordCachePromptFromUsage("anthropic", { cacheReadInputTokens: 500, cacheCreationInputTokens: 0 });

    const points = await pointsFor("fabula.cache.prompt");
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ provider: "anthropic", result: "hit" });
  });

  it("records a write when cacheCreationInputTokens > 0", async () => {
    m.recordCachePromptFromUsage("anthropic", { cacheCreationInputTokens: 200 });

    const points = await pointsFor("fabula.cache.prompt");
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ provider: "anthropic", result: "write" });
  });

  it("records both a hit and a write when a call reports both", async () => {
    m.recordCachePromptFromUsage("anthropic", { cacheReadInputTokens: 500, cacheCreationInputTokens: 200 });

    const points = await pointsFor("fabula.cache.prompt");
    const results = points.map((p) => p.attributes.result).sort();
    expect(results).toEqual(["hit", "write"]);
  });

  it("records a miss when neither is present", async () => {
    m.recordCachePromptFromUsage("openai", { inputTokens: 10, outputTokens: 5 } as never);

    const points = await pointsFor("fabula.cache.prompt");
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ provider: "openai", result: "miss" });
  });

  it("records nothing when usage itself is absent", async () => {
    m.recordCachePromptFromUsage("openai", undefined);

    expect(await pointsFor("fabula.cache.prompt")).toHaveLength(0);
  });
});

describe("no unbounded attribute value ever reaches an instrument", () => {
  // Every recorder is typed to accept only bounded enum-shaped parameters —
  // this test proves that holds at the data layer too, the same "assert
  // against a fixture, don't just trust the type system" discipline
  // route.test.ts already applies to span attributes.
  const FORBIDDEN_ATTRIBUTE_KEYS = ["userId", "storyId", "requestId", "email", "message", "text"];

  it("no data point anywhere carries a forbidden attribute key", async () => {
    m.recordGenerationTtft(1, { provider: "anthropic", model: "claude-sonnet-5", authenticated: false });
    m.recordGenerationDuration(1, { provider: "anthropic", outcome: "success" });
    m.recordGenerationTokens(1, { provider: "anthropic", kind: "input" });
    m.recordGenerationCostUsd(1, { provider: "anthropic", model: "claude-sonnet-5" });
    m.recordGenerationOutcome({ provider: "anthropic", outcome: "success" });
    m.generationStarted();
    m.generationEnded();
    m.recordRatelimitRejected("generate:guest");
    m.recordAdmissionRejected("per_user");
    m.recordBudgetExceeded("user");
    m.recordProviderCircuit("anthropic", "closed");
    m.recordCachePromptFromUsage("anthropic", { cacheReadInputTokens: 1 });
    m.recordStreamResume("resumed");
    m.recordAuthLogin("success");
    m.recordDbRoundtrips(1, "/api/generate");
    m.recordClientVital("CLS", 0.01, "/");
    m.recordClientError("/");

    const points = await allDataPoints();
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      for (const key of Object.keys(point.attributes)) {
        expect(FORBIDDEN_ATTRIBUTE_KEYS).not.toContain(key);
      }
    }
  });
});
