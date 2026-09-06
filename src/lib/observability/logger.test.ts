import { afterEach, describe, expect, it, vi } from "vitest";
import { trace, type Span, type SpanContext } from "@opentelemetry/api";
import { log, LOG_EVENTS } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log — the redaction allowlist", () => {
  it("drops an undeclared field and warns instead of passing it through", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    log.info(LOG_EVENTS.GENERATE_STARTED, {
      requestId: "req-1",
      // Not in the allowlist — this is the exact shape of bug the allowlist
      // exists to catch: someone passing story prose straight into a log call.
      storyText: "Once upon a time, a secret paragraph...",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warned = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(warned).toMatchObject({ event: "logger.unknown_field", field: "storyText" });

    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line).not.toHaveProperty("storyText");
    expect(JSON.stringify(line)).not.toContain("secret paragraph");
  });

  it("passes an allowlisted field through untouched", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    log.info(LOG_EVENTS.GENERATE_STARTED, { requestId: "req-1", providerId: "anthropic" });

    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ requestId: "req-1", providerId: "anthropic" });
  });
});

describe("log — trace correlation", () => {
  it("omits traceId/spanId when no span is active", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    log.info(LOG_EVENTS.GENERATE_STARTED, { requestId: "req-1" });

    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line).not.toHaveProperty("traceId");
    expect(line).not.toHaveProperty("spanId");
  });

  it("includes traceId/spanId from the active span", () => {
    // Spies on trace.getActiveSpan() directly rather than routing a real span
    // through context.with(): without a ContextManager registered (only
    // @vercel/otel's registerOTel() in src/instrumentation.ts does that, and
    // Next — not Vitest — is what calls it), context.with() is a no-op, which
    // would make this test pass or fail based on OTel SDK wiring rather than
    // logger.ts's own logic.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const spanContext: SpanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    };
    const fakeSpan = { spanContext: () => spanContext } as unknown as Span;
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(fakeSpan);

    log.info(LOG_EVENTS.GENERATE_STARTED, { requestId: "req-1" });

    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.traceId).toBe(spanContext.traceId);
    expect(line.spanId).toBe(spanContext.spanId);
  });
});

describe("log — output shape", () => {
  it("emits exactly one line of valid JSON per call", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    log.error(LOG_EVENTS.GENERATE_FAILED, { requestId: "req-1", outcome: "provider_error" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const raw = logSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
    const line = JSON.parse(raw);
    expect(line).toMatchObject({
      level: "error",
      event: LOG_EVENTS.GENERATE_FAILED,
      requestId: "req-1",
      outcome: "provider_error",
    });
    expect(typeof line.ts).toBe("string");
  });

  it("cannot have a field's embedded newline break the one-object-per-line format", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    log.info(LOG_EVENTS.PERSIST_FAILED, {
      requestId: "req-1",
      // err.message is the one allowlisted field most likely to carry an
      // adversarial or just-multi-line value (a stack-shaped SDK error, say).
      err: new Error("boom\nsecond line\nthird line"),
    });

    // A newline in the field must not fragment the call into multiple lines —
    // console.log is invoked exactly once with one JSON-serialised argument.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const raw = logSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
    const line = JSON.parse(raw);
    expect(line.err.message).toBe("boom\nsecond line\nthird line");
  });

  it("stringifies a non-Error thrown value rather than dropping it", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    log.error(LOG_EVENTS.PERSIST_FAILED, { requestId: "req-1", err: "a plain string throw" });

    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.err).toBe("a plain string throw");
  });
});
