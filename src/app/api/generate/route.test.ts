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
import { FIRST_CHUNK_TIMEOUT_MS, MAX_OUTPUT_TOKENS } from "@/lib/providers/constants";
import type {
  GenerateParagraphInput,
  GenerationResult,
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
  /** Throw before yielding anything, on every call — a bad API key or an
   *  invalid model that a retry can never recover from. */
  throwBeforeFirstChunk?: boolean;
  /** Throw before yielding, but only for this many calls, then behave
   *  normally — models a transient failure the single retry (rule 1) recovers
   *  from. Mutually exclusive with throwBeforeFirstChunk in practice. */
  failFirstCalls?: number;
  /** Throw after yielding — a connection dropped mid-generation. */
  throwAfterChunks?: boolean;
  /** Never resolves the first .next() until the route's AbortSignal fires —
   *  models a provider that accepted the request and stalled. */
  hang?: boolean;
  /** Yields these chunks, then never resolves the next .next() until the
   *  route's AbortSignal fires — models a mid-stream stall. Takes the place
   *  of `chunks` when set. */
  stallAfterChunks?: string[];
}

let lastInput: GenerateParagraphInput | undefined;
let returnCalled = false;
let fakeCallCount = 0;

/** Resolves once `signal` fires — never otherwise. */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** An AsyncGenerator that yields `chunks` then hangs until `signal` fires,
 *  at which point it throws — models a provider that stalls before or during
 *  a stream, ended only by the route's own timeout/disconnect handling. */
async function* hangingGenerator(
  chunks: string[],
  signal: AbortSignal | undefined
): AsyncGenerator<string, GenerationResult, unknown> {
  try {
    for (const chunk of chunks) yield chunk;
    await waitForAbort(signal);
    throw abortError();
  } finally {
    returnCalled = true;
  }
}

function installFake(options: FakeOptions = {}): LLMProvider {
  const {
    chunks = ["Once upon a time."],
    metadata,
    usage,
    model = "fake-model",
    throwBeforeFirstChunk,
    failFirstCalls = 0,
    throwAfterChunks,
    hang,
    stallAfterChunks,
  } = options;

  const provider: LLMProvider = {
    id: FAKE_ID,
    displayName: "Fake",
    generateParagraph(input) {
      lastInput = input;
      fakeCallCount += 1;
      const thisCall = fakeCallCount;

      if (hang) return hangingGenerator([], input.signal);
      if (stallAfterChunks) return hangingGenerator(stallAfterChunks, input.signal);

      return (async function* () {
        try {
          if (throwBeforeFirstChunk || thisCall <= failFirstCalls) {
            throw new Error("invalid api key");
          }
          for (const chunk of chunks) yield chunk;
          if (throwAfterChunks) throw new Error("connection reset");
          return { invented: metadata, usage, model };
        } finally {
          // Records that the route disposed of the generator on cancel.
          returnCalled = true;
        }
      })();
    },
  };

  PROVIDERS[FAKE_ID] = provider;
  return provider;
}

function post(body: unknown, opts?: { signal?: AbortSignal }): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: opts?.signal,
  });
}

/** A minimally valid request body for the guest path. */
function validBody(overrides: Record<string, unknown> = {}) {
  return { providerId: FAKE_ID, storySoFar: [], ...overrides };
}

let originalDatabaseUrl: string | undefined;
// registry.ts's isConfigured/suggestAlternative read these directly, and CI
// sets all three at the job level (see ci.yml) so `next build` succeeds — the
// same ambient-env trap DATABASE_URL has below. Cleared here so a 502's
// suggestedProviderId is deterministic; a test that wants one configured sets
// it explicitly.
const PROVIDER_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
let originalProviderEnv: Record<string, string | undefined>;

beforeEach(() => {
  lastInput = undefined;
  returnCalled = false;
  fakeCallCount = 0;

  // The route now runs guardGenerate() unconditionally (docs/adr/0015), which
  // makes hasDatabase() true — and the limiter fail closed with 429 — whenever
  // DATABASE_URL happens to be set in the ambient environment, whether or not
  // it's reachable. CI sets DATABASE_URL for `next build`'s benefit (see
  // ci.yml); this suite has no database and must not depend on that being
  // absent. Same pattern as guard.test.ts.
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  __setDbForTests(undefined);

  originalProviderEnv = Object.fromEntries(PROVIDER_ENV_VARS.map((v) => [v, process.env[v]]));
  for (const v of PROVIDER_ENV_VARS) delete process.env[v];
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
  for (const v of PROVIDER_ENV_VARS) {
    if (originalProviderEnv[v] === undefined) delete process.env[v];
    else process.env[v] = originalProviderEnv[v];
  }
  __setDbForTests(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  it("retries once against the same provider on a fast failure, and succeeds", async () => {
    // Case (a): the first call throws immediately (not a timeout) — rule 1
    // says retry once before giving up.
    installFake({ failFirstCalls: 1, chunks: ["It works on retry."] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("It works on retry.");
    expect(fakeCallCount).toBe(2);
  });

  it("returns a clean 502 with no suggestion when nothing else is configured and both attempts fail", async () => {
    // Case (b): the first attempt fails fast, so it retries once (rule 1);
    // the retry also fails, so it gives up. The first chunk is pre-fetched
    // precisely so this can be a JSON error the client can render, rather
    // than a 200 with a broken body.
    installFake({ throwBeforeFirstChunk: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));

    expect(response.status).toBe(502);
    expect(fakeCallCount).toBe(2);
    await expect(response.json()).resolves.toEqual({
      error: "Fake isn't responding right now.",
      kind: "provider-unavailable",
      failedProviderId: FAKE_ID,
    });
  });

  it("includes a named alternative in the 502 when another provider is configured", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    installFake({ throwBeforeFirstChunk: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));

    await expect(response.json()).resolves.toEqual({
      error: "Fake isn't responding right now.",
      kind: "provider-unavailable",
      failedProviderId: FAKE_ID,
      suggestedProviderId: "anthropic",
      suggestedProviderName: PROVIDERS.anthropic.displayName,
    });
  });

  it("does not distinguish a bad key from an outage in the client-facing message", async () => {
    // Same uninformative-by-design posture as ADR 0011 — the message text is
    // fixed regardless of the underlying error, even though the real cause
    // (a rejected .next() vs. our own timeout) differs server-side.
    vi.spyOn(console, "error").mockImplementation(() => {});

    installFake({ throwBeforeFirstChunk: true });
    const response1 = await POST(post(validBody()));
    const data1 = await response1.json();

    delete PROVIDERS[FAKE_ID];
    fakeCallCount = 0;
    vi.useFakeTimers();
    installFake({ hang: true });
    const responsePromise = POST(post(validBody()));
    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS);
    const data2 = await (await responsePromise).json();

    expect(data1.error).toBe(data2.error);
  });

  it("times out and gives up without retrying when the provider hangs before any chunk", async () => {
    // Case (c): a timeout (not a fast error) never retries — rule 2.
    vi.useFakeTimers();
    installFake({ hang: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const responsePromise = POST(post(validBody()));
    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(502);
    expect(fakeCallCount).toBe(1);
    await expect(response.json()).resolves.toMatchObject({ kind: "provider-unavailable" });
  });

  it("errors the stream (no suggestion) on a mid-stream idle stall", async () => {
    // Case (d): a stall after streaming has begun is never offered as a
    // provider switch (rule 3) — same controller.error() path as any other
    // mid-stream failure.
    vi.useFakeTimers();
    installFake({ stallAfterChunks: ["The story begins, ", "then falls silent."] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));
    expect(response.status).toBe(200);
    const textPromise = response.text();
    // Safety-net catch attached in the same tick as creation: response.text()'s
    // promise actually settles as a side effect of runAllTimersAsync() below,
    // before the real assertion (the next line after it) gets a chance to
    // subscribe — a gap Node's unhandledRejection detector can flag even though
    // the rejection is fully handled a tick later. Harmless: multiple handlers
    // on one promise don't interfere with each other.
    textPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(textPromise).rejects.toThrow();
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

  it("cancels a client that disconnects before the first chunk, with no error response", async () => {
    // Case (e): request.signal firing pre-first-chunk must abort the upstream
    // call rather than merely being ignored, and must not surface as a 502.
    installFake({ hang: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();

    const responsePromise = POST(post(validBody(), { signal: controller.signal }));
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(499);
    expect(fakeCallCount).toBe(1); // never retried
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

  it("still ends exactly one span when a mid-stream disconnect fires both request.signal and the stream's own cancel()", async () => {
    // The exact race the idempotency gotcha (docs/adr/0023) is about: a real
    // client disconnect can trip request.signal's abort listener AND the
    // platform's own ReadableStream cancel() for the same event. Whichever
    // wins, finish() (and thus the span) must run exactly once. Uses a fake
    // that actually respects the signal (stallAfterChunks), so aborting makes
    // iterator.next() reject — the only way to reach pull()'s own abort
    // handling, not just cancel()'s.
    installFake({ stallAfterChunks: ["one", "two"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();

    const response = await POST(post(validBody(), { signal: controller.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    await reader.cancel("writer navigated away");

    expect(returnCalled).toBe(true);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["fabula.outcome"]).toBe("cancelled");
  });

  it("ends exactly one span, outcome cancelled, when the client disconnects before the first chunk", async () => {
    installFake({ hang: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();

    const responsePromise = POST(post(validBody(), { signal: controller.signal }));
    controller.abort();
    await responsePromise;

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["fabula.outcome"]).toBe("cancelled");
    // Same span-status convention as any other cancellation (see the test above).
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("ends exactly one span, with ERROR status, on a mid-stream idle stall", async () => {
    vi.useFakeTimers();
    installFake({ stallAfterChunks: ["one", "two"] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post(validBody()));
    const textPromise = response.text();
    // Safety-net catch attached in the same tick as creation: response.text()'s
    // promise actually settles as a side effect of runAllTimersAsync() below,
    // before the real assertion (the next line after it) gets a chance to
    // subscribe — a gap Node's unhandledRejection detector can flag even though
    // the rejection is fully handled a tick later. Harmless: multiple handlers
    // on one promise don't interfere with each other.
    textPromise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(textPromise).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["fabula.outcome"]).toBe("provider_error");
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});
