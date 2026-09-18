import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { withRoute } from "./withRoute";
import { readActiveRoundtripCount } from "./requestContext";

/**
 * Registering a ContextManager (this project's global setup,
 * src/test/setup-otel-context.ts) is what makes context.with actually
 * propagate — without it, withRoute's own span nesting and round-trip
 * counting would be no-ops in this test file, the same requirement ADR
 * 0022 already documents for span parent/child correlation.
 */

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

beforeEach(() => {
  exporter.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withRoute — spans", () => {
  it("produces exactly one span per request, named http.route, with method/route/request-id attributes", async () => {
    const handler = withRoute("/api/stories", async () => Response.json({ ok: true }));

    await handler(new Request("http://localhost/api/stories", { method: "GET" }));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("http.route");
    expect(spans[0].attributes["http.route"]).toBe("/api/stories");
    expect(spans[0].attributes["http.method"]).toBe("GET");
    expect(typeof spans[0].attributes["fabula.request_id"]).toBe("string");
  });

  it("records the response status code and ends without ERROR status on a 200", async () => {
    const handler = withRoute("/api/stories", async () => Response.json({ ok: true }, { status: 201 }));

    await handler(new Request("http://localhost/api/stories"));

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["http.status_code"]).toBe(201);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("marks the span ERROR when the handler itself returns a 5xx", async () => {
    const handler = withRoute("/api/stories", async () => Response.json({ error: "oops" }, { status: 502 }));

    await handler(new Request("http://localhost/api/stories"));

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["http.status_code"]).toBe(502);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("still ends exactly one span, ERROR status, when the handler throws — the error path", async () => {
    const handler = withRoute("/api/stories", async () => {
      throw new Error("boom");
    });

    const response = await handler(new Request("http://localhost/api/stories"));

    expect(response.status).toBe(500);
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("handles a non-Error thrown value the same way", async () => {
    const handler = withRoute("/api/stories", async () => {
      throw "a plain string throw";
    });

    const response = await handler(new Request("http://localhost/api/stories"));

    expect(response.status).toBe(500);
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("nests a span the handler itself starts as a child of http.route", async () => {
    const tracer = trace.getTracer("fabula");
    const handler = withRoute("/api/generate", async () => {
      const inner = tracer.startSpan("fabula.generate");
      inner.end();
      return Response.json({ ok: true });
    });

    await handler(new Request("http://localhost/api/generate"));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const outer = spans.find((s) => s.name === "http.route")!;
    const inner = spans.find((s) => s.name === "fabula.generate")!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });
});

describe("withRoute — x-request-id", () => {
  it("sets x-request-id on a successful response", async () => {
    const handler = withRoute("/api/stories", async () => Response.json({ ok: true }));

    const response = await handler(new Request("http://localhost/api/stories"));

    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("sets x-request-id on the synthesized 500 error response", async () => {
    const handler = withRoute("/api/stories", async () => {
      throw new Error("boom");
    });

    const response = await handler(new Request("http://localhost/api/stories"));

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("sets x-request-id even on a response with immutable headers (Response.redirect)", async () => {
    const handler = withRoute("/api/auth/verify/[token]", async () => Response.redirect("http://localhost/verify"));

    const response = await handler(new Request("http://localhost/api/auth/verify/abc"));

    expect(response.status).toBe(302);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("Location")).toBe("http://localhost/verify");
  });

  it("echoes back a valid inbound x-request-id rather than minting a new one", async () => {
    const handler = withRoute("/api/stories", async () => Response.json({ ok: true }));

    const response = await handler(
      new Request("http://localhost/api/stories", { headers: { "x-request-id": "client-supplied-id-123" } })
    );

    expect(response.headers.get("x-request-id")).toBe("client-supplied-id-123");
  });

  it("replaces, rather than echoes, an invalid inbound x-request-id", async () => {
    const handler = withRoute("/api/stories", async () => Response.json({ ok: true }));

    const response = await handler(
      // A header value with a space is well-formed HTTP but fails
      // requestId.ts's [A-Za-z0-9._-]{1,128} allowlist — a literal control
      // character (the log-injection shape that validation ultimately
      // guards against) isn't even constructible via the Headers API, which
      // already rejects it at Request-construction time.
      new Request("http://localhost/api/stories", { headers: { "x-request-id": "bad id with spaces" } })
    );

    const id = response.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect(id).not.toBe("bad id with spaces");
  });
});

describe("withRoute — fabula.db.roundtrips self-reporting", () => {
  // Every other test in this file exercises a handler that never calls
  // incrementActiveRoundtripCounter — none of them throw or hang, which is
  // itself the "counter.count is 0, recording is skipped" branch working;
  // a dedicated OTel-reader assertion here would need to fight metrics.ts's
  // own module-scope instrument caching (see metrics.test.ts) for no
  // additional signal.

  it("records fabula.db.roundtrips itself for an ordinary (non-streaming) route that made counted calls", async () => {
    const { metrics } = await import("@opentelemetry/api");
    const { MeterProvider, MetricReader } = await import("@opentelemetry/sdk-metrics");
    class TestReader extends MetricReader {
      protected async onForceFlush() {}
      protected async onShutdown() {}
    }
    const reader = new TestReader();
    const meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
    vi.resetModules();
    const { withRoute: freshWithRoute } = await import("./withRoute");
    const { incrementActiveRoundtripCounter: freshIncrement } = await import("./requestContext");

    const handler = freshWithRoute("/api/stories", async () => {
      freshIncrement();
      freshIncrement();
      freshIncrement();
      return Response.json({ ok: true });
    });
    await handler(new Request("http://localhost/api/stories"));

    const { resourceMetrics } = await reader.collect();
    const dbMetric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((mm) => mm.descriptor.name === "fabula.db.roundtrips");
    expect(dbMetric).toBeDefined();
    const [point] = dbMetric!.dataPoints;
    expect((point.value as unknown as { sum: number }).sum).toBe(3);
    expect(point.attributes).toEqual({ route: "/api/stories" });

    await meterProvider.shutdown();
    metrics.disable();
  });

  it("skips its own recording when selfReportsRoundtrips is set, leaving the count in requestContext readable by the handler", async () => {
    const { incrementActiveRoundtripCounter } = await import("./requestContext");
    let observedDuringHandler = -1;

    const handler = withRoute(
      "/api/generate",
      async () => {
        incrementActiveRoundtripCounter();
        incrementActiveRoundtripCounter();
        observedDuringHandler = readActiveRoundtripCount();
        return new Response(new ReadableStream(), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      { selfReportsRoundtrips: true }
    );

    await handler(new Request("http://localhost/api/generate"));

    expect(observedDuringHandler).toBe(2);
  });
});

describe("requestContext — outside any withRequestScope", () => {
  it("incrementActiveRoundtripCounter is a no-op, and readActiveRoundtripCount reads 0", async () => {
    const { incrementActiveRoundtripCounter, readActiveRoundtripCount: freshRead } = await import(
      "./requestContext"
    );
    expect(() => incrementActiveRoundtripCounter()).not.toThrow();
    expect(freshRead()).toBe(0);
  });
});

describe("requestContext — getActiveRequestId", () => {
  it("reads back the same request id withRoute resolved, from inside the handler", async () => {
    const { getActiveRequestId } = await import("./requestContext");
    let observed: string | undefined;
    const handler = withRoute("/api/stories", async () => {
      observed = getActiveRequestId();
      return Response.json({ ok: true });
    });

    const response = await handler(
      new Request("http://localhost/api/stories", { headers: { "x-request-id": "match-me-123" } })
    );

    expect(observed).toBe("match-me-123");
    expect(response.headers.get("x-request-id")).toBe("match-me-123");
  });

  it("is undefined outside any withRequestScope", async () => {
    const { getActiveRequestId } = await import("./requestContext");
    expect(getActiveRequestId()).toBeUndefined();
  });
});

describe("withRoute — generic over handler signatures", () => {
  it("passes a second RouteContext-shaped argument through unchanged", async () => {
    const handler = withRoute(
      "/api/stories/[id]",
      async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
        const { id } = await params;
        return Response.json({ id });
      }
    );

    const response = await handler(new Request("http://localhost/api/stories/abc"), {
      params: Promise.resolve({ id: "abc" }),
    });

    await expect(response.json()).resolves.toEqual({ id: "abc" });
  });
});
