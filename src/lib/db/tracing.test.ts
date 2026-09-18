import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { wrapWithTracing } from "./tracing";
import { withRequestScope } from "@/lib/observability/requestContext";
import type { AppDatabase } from "./types";

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

/** A fake matching just enough of AppDatabase's shape for the Proxy's four
 *  counted methods, plus one uncounted method to prove pass-through. */
function fakeDb(overrides: Partial<Record<"select" | "insert" | "update" | "execute", (...args: unknown[]) => unknown>> = {}) {
  return {
    select: overrides.select ?? (() => ({ from: () => ({ where: async () => [{ id: "row-1" }] }) })),
    insert: overrides.insert ?? (() => ({ values: () => ({ returning: async () => [{ id: "row-1" }] }) })),
    update: overrides.update ?? (() => ({ set: () => ({ where: async () => undefined }) })),
    execute: overrides.execute ?? (async () => ({ rows: [] })),
    query: "not-a-counted-method",
  } as unknown as AppDatabase;
}

describe("wrapWithTracing — a child span per statement", () => {
  it("emits a db.execute span for execute()", async () => {
    const db = wrapWithTracing(fakeDb());

    await db.execute({} as never);

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("db.execute");
    expect(span.attributes["db.system"]).toBe("postgresql");
    expect(span.attributes["db.statement"]).toBe("execute(...)");
  });

  it("emits a db.select span with the column-alias shape, never bound values", async () => {
    const db = wrapWithTracing(fakeDb());

    // db.select() itself is synchronous — the Proxy's trap runs, and ends
    // its span, at call time (docs/db/tracing.ts's own doc comment on why).
    db.select({ id: {}, ownerId: {} } as never);

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("db.select");
    expect(span.attributes["db.statement"]).toBe("select(id, ownerId)");
  });

  it("falls back to select(*) when no column shape is given", async () => {
    const db = wrapWithTracing(fakeDb());

    db.select(undefined as never);

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["db.statement"]).toBe("select(*)");
  });

  it("falls back to select(*) for an empty (but present) column-alias object", async () => {
    const db = wrapWithTracing(fakeDb());

    db.select({} as never);

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["db.statement"]).toBe("select(*)");
  });

  it("emits db.insert / db.update spans with a generic, argument-free label", async () => {
    const db = wrapWithTracing(fakeDb());

    db.insert({} as never);
    db.update({} as never);

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["db.insert", "db.update"]);
    expect(spans[0].attributes["db.statement"]).toBe("insert(...)");
    expect(spans[1].attributes["db.statement"]).toBe("update(...)");
  });

  it("never puts a bound value — a known paragraph string — in any span attribute", async () => {
    const secretProse = "The dragon's secret name was Zylathorn.";
    const db = wrapWithTracing(fakeDb());

    // The top-level call itself never receives the paragraph text — it's
    // only ever passed to .values()/.where(), which this Proxy does not
    // intercept (see tracing.ts's own doc comment on why that's safe by
    // construction, not by omission).
    db.insert({ text: secretProse } as never);
    await db.execute({ sql: `insert into x values ('${secretProse}')` } as never);

    const spans = exporter.getFinishedSpans();
    for (const span of spans) {
      expect(JSON.stringify(span.attributes)).not.toContain(secretProse);
      expect(JSON.stringify(span.attributes)).not.toContain("dragon");
    }
  });

  it("passes through the call's real return value and arguments unchanged", async () => {
    const db = wrapWithTracing(fakeDb());

    const result = await db.execute({} as never);

    expect(result).toEqual({ rows: [] });
  });

  it("does not wrap an uncounted property — it passes through untouched", () => {
    const db = wrapWithTracing(fakeDb());

    expect(db.query).toBe("not-a-counted-method");
  });

  it("records the exception and sets ERROR status when the top-level call throws synchronously", async () => {
    const err = new Error("connection reset");
    const db = wrapWithTracing(
      fakeDb({
        execute: () => {
          throw err;
        },
      })
    );

    expect(() => db.execute({} as never)).toThrow("connection reset");

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("stringifies a non-Error thrown value rather than dropping it", () => {
    const db = wrapWithTracing(
      fakeDb({
        execute: () => {
          throw "a plain string throw";
        },
      })
    );

    expect(() => db.execute({} as never)).toThrow();

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("wrapWithTracing — composes with round-trip counting", () => {
  it("increments the active request's round-trip counter on every counted call", async () => {
    const db = wrapWithTracing(fakeDb());

    const { result, counter } = withRequestScope("req-1", async () => {
      db.select({ id: {} } as never);
      db.insert({} as never);
      await db.execute({} as never);
      return "done";
    });

    await result;
    expect(counter.count).toBe(3);
  });

  it("does not increment the counter for an uncounted property access", async () => {
    const db = wrapWithTracing(fakeDb());

    const { result, counter } = withRequestScope("req-1", async () => {
      void db.query;
      return "done";
    });

    await result;
    expect(counter.count).toBe(0);
  });
});

describe("wrapWithTracing — nests under the active span (context propagation)", () => {
  it("parents a db span onto whatever span is active when the call happens", async () => {
    const tracer = trace.getTracer("fabula");
    const db = wrapWithTracing(fakeDb());

    const outer = tracer.startSpan("http.route");
    context.with(trace.setSpan(context.active(), outer), () => {
      db.select({ id: {} } as never);
    });
    outer.end();

    const spans = exporter.getFinishedSpans();
    const dbSpan = spans.find((s) => s.name === "db.select")!;
    expect(dbSpan.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });
});
