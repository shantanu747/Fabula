import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { estimateCostUsd } from "@/lib/providers/pricing";

// The route imports `auth` at module scope even though the guest path never
// calls it, and next-auth's module graph does not load outside a Next runtime.
// This is the same single module mock the db suite installs — see
// src/test/session.ts and docs/adr/0014 for why `auth` is the one exception to
// injection-over-mocking.
vi.mock("@/auth", async () => {
  const { getTestSession } = await import("@/test/session");
  return {
    auth: async () => getTestSession(),
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  };
});

import { POST } from "./route";
import { __setDbForTests } from "@/lib/db/client";
import { PROVIDERS } from "@/lib/providers/registry";
import { MAX_OUTPUT_TOKENS } from "@/lib/providers/constants";
import type {
  GenerateParagraphInput,
  InventedMetadata,
  LLMProvider,
  TokenUsage,
} from "@/lib/providers/types";

/**
 * The guest path end to end, with a fake provider standing in for the LLM.
 *
 * No module mocking is involved. PROVIDERS is an exported mutable record and
 * getProvider does a live lookup per call, so a fake registers by assignment —
 * the seam was already there. And the guest path (no storyId) touches neither
 * auth() nor the database: both getDb() calls sit behind `if (input.storyId)`.
 * The persisted path is covered in route.db.test.ts against a real Postgres.
 */
const FAKE_ID = "fake-provider";
const SENTINEL = "\n FABULA:METADATA ";

interface FakeOptions {
  chunks?: string[];
  metadata?: InventedMetadata;
  usage?: TokenUsage;
  model?: string;
  /** Throw before yielding anything — a bad API key or an invalid model. */
  throwBeforeFirstChunk?: boolean;
  /** Throw after yielding — a connection dropped mid-generation. */
  throwAfterChunks?: boolean;
}

let lastInput: GenerateParagraphInput | undefined;
let returnCalled = false;

function installFake(options: FakeOptions = {}): LLMProvider {
  const {
    chunks = ["Once upon a time."],
    metadata,
    usage,
    model = "fake-model",
    throwBeforeFirstChunk,
    throwAfterChunks,
  } = options;

  const provider: LLMProvider = {
    id: FAKE_ID,
    displayName: "Fake",
    async *generateParagraph(input) {
      lastInput = input;
      if (throwBeforeFirstChunk) throw new Error("invalid api key");
      try {
        for (const chunk of chunks) yield chunk;
        if (throwAfterChunks) throw new Error("connection reset");
        return { invented: metadata, usage, model };
      } finally {
        // Records that the route disposed of the generator on cancel.
        returnCalled = true;
      }
    },
  };

  PROVIDERS[FAKE_ID] = provider;
  return provider;
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A minimally valid request body for the guest path. */
function validBody(overrides: Record<string, unknown> = {}) {
  return { providerId: FAKE_ID, storySoFar: [], ...overrides };
}

let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  lastInput = undefined;
  returnCalled = false;

  // The route now runs guardGenerate() unconditionally (docs/adr/0015), which
  // makes hasDatabase() true — and the limiter fail closed with 429 — whenever
  // DATABASE_URL happens to be set in the ambient environment, whether or not
  // it's reachable. CI sets DATABASE_URL for `next build`'s benefit (see
  // ci.yml); this suite has no database and must not depend on that being
  // absent. Same pattern as guard.test.ts.
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  __setDbForTests(undefined);
  // The structured logger (src/lib/observability/logger.ts) writes every level
  // through console.log, not console.error/warn/info — silence it here so
  // individual tests don't each need their own mock, matching the existing
  // per-test console.error/info mocks below for the same reason.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete PROVIDERS[FAKE_ID];
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  __setDbForTests(undefined);
  vi.restoreAllMocks();
});

describe("POST /api/generate — request validation", () => {
  it("rejects a body that is not JSON", async () => {
    installFake();

    const response = await POST(post("not json at all"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it.each([
    ["a null body", null],
    ["a non-object body", 42],
    ["a missing providerId", { storySoFar: [] }],
    ["a non-string providerId", { providerId: 7, storySoFar: [] }],
    ["a missing storySoFar", { providerId: FAKE_ID }],
    ["a non-array storySoFar", { providerId: FAKE_ID, storySoFar: "nope" }],
    ["a paragraph with an unknown author", { providerId: FAKE_ID, storySoFar: [{ author: "dog", text: "x" }] }],
    ["a paragraph with non-string text", { providerId: FAKE_ID, storySoFar: [{ author: "writer", text: 3 }] }],
    ["a non-integer targetLength", { providerId: FAKE_ID, storySoFar: [], targetLength: 4.5 }],
    ["an out-of-range targetLength", { providerId: FAKE_ID, storySoFar: [], targetLength: 9999 }],
    ["an over-long theme", { providerId: FAKE_ID, storySoFar: [], theme: "x".repeat(5000) }],
    ["a non-string storyId", { providerId: FAKE_ID, storySoFar: [], storyId: 12 }],
  ])("rejects %s with a 400", async (_label, body) => {
    installFake();

    const response = await POST(post(body));

    expect(response.status).toBe(400);
  });

  it("rejects an unknown provider by name", async () => {
    const response = await POST(post({ providerId: "does-not-exist", storySoFar: [] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown provider: does-not-exist",
    });
  });
});

describe("POST /api/generate — turn policy", () => {
  it("refuses to let the AI write twice in a row", async () => {
    // Enforced server-side, not only in the UI: the client gate is a courtesy,
    // this is the rule.
    installFake();

    const response = await POST(
      post(validBody({ storySoFar: [{ author: "ai", text: "The AI just wrote." }] }))
    );

    expect(response.status).toBe(409);
    expect(lastInput).toBeUndefined(); // never reached the provider, never billed
  });

  it("lets the AI open the story when nothing has been written", async () => {
    installFake();

    const response = await POST(post(validBody({ storySoFar: [] })));

    expect(response.status).toBe(200);
  });

  it("lets the AI follow the Writer", async () => {
    installFake();

    const response = await POST(
      post(validBody({ storySoFar: [{ author: "writer", text: "I wrote this." }] }))
    );

    expect(response.status).toBe(200);
  });
});

describe("POST /api/generate — streaming", () => {
  it("streams the provider's chunks as the response body", async () => {
    installFake({ chunks: ["Once ", "upon ", "a time."] });

    const response = await POST(post(validBody()));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    // Never cache a story paragraph — every generation is unique.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("Once upon a time.");
  });

  it("appends invented metadata after the sentinel", async () => {
    const metadata = { theme: "noir", characters: "a detective" };
    installFake({ chunks: ["It rained."], metadata });

    const response = await POST(post(validBody()));

    await expect(response.text()).resolves.toBe(
      `It rained.${SENTINEL}${JSON.stringify(metadata)}`
    );
  });

  it("emits no sentinel when the provider invented nothing", async () => {
    installFake({ chunks: ["It rained."] });

    const response = await POST(post(validBody()));

    await expect(response.text()).resolves.toBe("It rained.");
  });

  it("emits metadata even when the provider returns it without any prose", async () => {
    // The generator finishes on its very first .next(), so this exercises the
    // `first.done` branch that the pull() loop never reaches.
    const metadata = { theme: "noir" };
    installFake({ chunks: [], metadata });

    const response = await POST(post(validBody()));

    await expect(response.text()).resolves.toBe(`${SENTINEL}${JSON.stringify(metadata)}`);
  });

  it("forwards the Writer's hints and the token cap to the provider", async () => {
    installFake();

    await POST(
      post(
        validBody({
          theme: "noir",
          characters: "a detective",
          openingLines: "It rained.",
          targetLength: 12,
        })
      )
    );

    expect(lastInput).toMatchObject({
      theme: "noir",
      characters: "a detective",
      openingLines: "It rained.",
      targetLength: 12,
      // No call site may skip the per-request cost cap.
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  });
});

describe("POST /api/generate — provider failures", () => {
  it("returns a clean 502 when the provider fails before the first chunk", async () => {
    // The first chunk is pre-fetched precisely so this can be a JSON error the
    // client can render, rather than a 200 with a broken body.
    installFake({ throwBeforeFirstChunk: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Generation failed to start" });
  });

  it("errors the stream when the provider fails after streaming has begun", async () => {
    // The headers are long gone, so the only way to tell the client is to break
    // the stream — which is what drives its one auto-retry. Closing normally
    // would present a truncated paragraph as a finished one.
    installFake({ chunks: ["The story begins"], throwAfterChunks: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it("disposes of the provider generator when the client goes away", async () => {
    // Without this the provider keeps generating — and keeps billing — for a
    // Writer who already navigated away.
    installFake({ chunks: ["one", "two", "three", "four"] });
    vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await POST(post(validBody()));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("writer navigated away");

    expect(returnCalled).toBe(true);
  });
});

describe("POST /api/generate — OTel spans", () => {
  // route.ts's module-scope `tracer` is a ProxyTracer (see @opentelemetry/api)
  // that resolves its real delegate lazily on first .startSpan() call, so
  // registering the provider here — after route.ts was already imported above
  // — still works: nothing calls .startSpan() until a test actually POSTs.
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

  it("ends exactly one span on success, with usage/cost/ttft/total attributes", async () => {
    const usage = { inputTokens: 10, outputTokens: 5 };
    installFake({ chunks: ["Hello ", "world."], usage, model: "claude-sonnet-5" });

    const response = await POST(post(validBody()));
    await response.text();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("fabula.generate");
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes["fabula.outcome"]).toBe("success");
    expect(span.attributes["gen_ai.system"]).toBe(FAKE_ID);
    expect(span.attributes["gen_ai.request.model"]).toBe("claude-sonnet-5");
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(5);
    expect(span.attributes["fabula.cost_usd"]).toBeCloseTo(estimateCostUsd("claude-sonnet-5", usage)!, 10);
    expect(typeof span.attributes["fabula.ttft_ms"]).toBe("number");
    expect(typeof span.attributes["fabula.total_ms"]).toBe("number");
    expect(span.attributes["fabula.authenticated"]).toBe(false);
  });

  it("never puts story prose in a span attribute", async () => {
    const secretProse = "The dragon's secret name was Zylathorn.";
    installFake({ chunks: [secretProse], usage: { inputTokens: 1, outputTokens: 1 } });

    const response = await POST(post(validBody()));
    await response.text();

    const [span] = exporter.getFinishedSpans();
    expect(JSON.stringify(span.attributes)).not.toContain(secretProse);
    expect(JSON.stringify(span.attributes)).not.toContain("dragon");
  });

  it("ends exactly one span, with ERROR status, on a provider error before the first chunk", async () => {
    installFake({ throwBeforeFirstChunk: true });

    await POST(post(validBody()));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["fabula.outcome"]).toBe("provider_error");
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("ends exactly one span, with ERROR status, on a mid-stream provider error", async () => {
    installFake({ chunks: ["The story begins"], throwAfterChunks: true });

    const response = await POST(post(validBody()));
    await expect(response.text()).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["fabula.outcome"]).toBe("provider_error");
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("ends exactly one span on cancellation", async () => {
    installFake({ chunks: ["one", "two", "three", "four"] });

    const response = await POST(post(validBody()));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("writer navigated away");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["fabula.outcome"]).toBe("cancelled");
    expect(spans[0].attributes["fabula.persisted"]).toBe(false);
  });
});
