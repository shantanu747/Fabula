import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import type { AppDatabase } from "@/lib/db/types";

class TestMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let reader: TestMetricReader;
let provider: MeterProvider;
let POST: typeof import("./route").POST;
let __setDbForTests: typeof import("@/lib/db/client").__setDbForTests;
let __setKvForTests: typeof import("@/lib/kv/client").__setKvForTests;
let originalDatabaseUrl: string | undefined;
let originalKvUrl: string | undefined;
let originalKvToken: string | undefined;

// vi.resetModules() (needed so metrics.ts's own lazy-cached instruments
// rebind to this test's fresh MeterProvider — see metrics.test.ts's doc
// comment) clears the *whole* module registry, not just metrics.ts. A
// statically-imported `__setDbForTests`/`__setKvForTests` would then point
// at a stale db/client.ts or kv/client.ts instance, disconnected from the
// one route.ts's own fresh import resolves against — all three need to
// come from the same fresh pass.
//
// DATABASE_URL and the KV_REST_API_* pair are explicitly cleared, not just
// db/kv left uninjected — hasDatabase()/hasKv() are true if *either* the
// injected handle or the env var is set, and every "no fake db/kv
// installed" test below assumes the rate limiter is off (or, for the
// fail-closed test, routed to the fake Postgres it installs, not a real
// reachable Redis). CI's build job sets DATABASE_URL at job level
// (AGENTS.md), and a local run with KV_REST_API_URL pointed at a real
// serverless-redis-http instance is exactly this repo's own recommended
// local dev setup — a test that silently depends on either being unset has
// already broken this way once (guard.ts's own tests carry the same note
// for DATABASE_URL; this file needed the KV half too).
beforeEach(async () => {
  reader = new TestMetricReader();
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  originalDatabaseUrl = process.env.DATABASE_URL;
  originalKvUrl = process.env.KV_REST_API_URL;
  originalKvToken = process.env.KV_REST_API_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  vi.resetModules();
  ({ POST } = await import("./route"));
  ({ __setDbForTests } = await import("@/lib/db/client"));
  ({ __setKvForTests } = await import("@/lib/kv/client"));
  __setDbForTests(undefined);
  __setKvForTests(undefined);
});

afterEach(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalKvUrl;
  if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = originalKvToken;
  await provider.shutdown();
  metrics.disable();
  __setDbForTests(undefined);
  vi.restoreAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/telemetry", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface FlatPoint {
  attributes: Record<string, unknown>;
  value: unknown;
}

async function pointsFor(metricName: string): Promise<FlatPoint[]> {
  const { resourceMetrics } = await reader.collect();
  const points: FlatPoint[] = [];
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== metricName) continue;
      for (const dp of metric.dataPoints) {
        points.push({ attributes: dp.attributes, value: dp.value });
      }
    }
  }
  return points;
}

describe("POST /api/telemetry — origin", () => {
  it("rejects a request with no Origin header", async () => {
    const request = new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "vital", name: "LCP", value: 1000, route: "/" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it("rejects a cross-site Origin", async () => {
    const response = await POST(post({ kind: "vital", name: "LCP", value: 1000, route: "/" }, { origin: "https://evil.example" }));

    expect(response.status).toBe(403);
  });
});

describe("POST /api/telemetry — vital payloads", () => {
  it("accepts a valid vital, returns 204, records it under the normalized route", async () => {
    const response = await POST(post({ kind: "vital", name: "LCP", value: 1834, route: "/feed/some-story-id" }));

    expect(response.status).toBe(204);
    const points = await pointsFor("fabula.client.vital");
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ name: "LCP", route: "/feed/[id]" });
    expect((points[0].value as unknown as { sum: number }).sum).toBe(1834);
  });

  it.each(["FCP", "Next.js-hydration", "FID", "bogus"])("rejects an unlisted vital name (%s)", async (name) => {
    const response = await POST(post({ kind: "vital", name, value: 100, route: "/" }));

    expect(response.status).toBe(400);
    expect(await pointsFor("fabula.client.vital")).toHaveLength(0);
  });

  it("rejects a non-finite value", async () => {
    const response = await POST(post({ kind: "vital", name: "CLS", value: Number.NaN, route: "/" }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/telemetry — error payloads", () => {
  it("accepts a valid error report with a digest, returns 204, records it", async () => {
    const response = await POST(post({ kind: "error", digest: "abc123", route: "/story" }));

    expect(response.status).toBe(204);
    const points = await pointsFor("fabula.client.error");
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({ route: "/story" });
  });

  it("accepts an error report with no digest at all", async () => {
    const response = await POST(post({ kind: "error", route: "/story" }));
    expect(response.status).toBe(204);
  });

  it("rejects a non-string digest", async () => {
    const response = await POST(post({ kind: "error", digest: 12345, route: "/story" }));
    expect(response.status).toBe(400);
  });

  it("never records or logs a message/stack field even if one is smuggled in", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await POST(
      post({ kind: "error", digest: "abc", route: "/story", message: "leaked user text", stack: "at foo()" })
    );

    expect(response.status).toBe(204);
    const lines = logSpy.mock.calls.map(([line]) => line as string).join("\n");
    expect(lines).not.toContain("leaked user text");
    expect(lines).not.toContain("at foo()");
  });
});

describe("POST /api/telemetry — strict shape validation", () => {
  it("rejects a body that isn't a JSON object at all", async () => {
    const request = new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify("just a string"),
    });

    expect((await POST(request)).status).toBe(400);

    const nullRequest = new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify(null),
    });
    expect((await POST(nullRequest)).status).toBe(400);
  });

  it("rejects an unknown kind", async () => {
    const response = await POST(post({ kind: "not-a-real-kind", route: "/" }));
    expect(response.status).toBe(400);
  });

  it("rejects a missing route", async () => {
    const response = await POST(post({ kind: "vital", name: "LCP", value: 1 }));
    expect(response.status).toBe(400);
  });

  it("rejects an oversized route string", async () => {
    const response = await POST(post({ kind: "vital", name: "LCP", value: 1, route: "/" + "a".repeat(500) }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: "{not json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const request = new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ kind: "error", route: "/", digest: "a".repeat(5000) }),
    });

    const response = await POST(request);
    expect(response.status).toBe(413);
  });
});

describe("POST /api/telemetry — rate limiting", () => {
  it("fails closed (429) when the rate-limit check itself errors", async () => {
    __setDbForTests({
      execute: async () => {
        throw new Error("database is down");
      },
    } as unknown as AppDatabase);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await POST(post({ kind: "vital", name: "LCP", value: 1, route: "/" }));

    expect(response.status).toBe(429);
  });
});

describe("POST /api/telemetry — withRoute integration", () => {
  it("carries an x-request-id response header", async () => {
    const response = await POST(post({ kind: "vital", name: "TTFB", value: 200, route: "/" }));
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
