import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { streamGeneration, type GenerateRequestBody } from "./streamGeneration";
import { encodeStreamEvent, type StreamEvent } from "@/lib/streaming/protocol";
import type { InventedMetadata } from "@/lib/providers/types";

const BODY: GenerateRequestBody = { providerId: "anthropic", storySoFar: [] };
const RESUME_URL_RE = /\/api\/generate\/([^/]+)\/resume$/;

/** Encodes a sequence of events into the wire bytes the real route would send. */
function encodeAll(events: StreamEvent[], startId = 1): Uint8Array {
  let id = startId;
  const text = events.map((e) => encodeStreamEvent(id++, e)).join("");
  return new TextEncoder().encode(text);
}

/** Splits a byte array at the given offsets — byte boundaries, not char ones. */
function splitBytes(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const cuts = [...new Set(offsets.filter((o) => o > 0 && o < bytes.length))].sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  let prev = 0;
  for (const cut of cuts) {
    parts.push(bytes.subarray(prev, cut));
    prev = cut;
  }
  parts.push(bytes.subarray(prev));
  return parts;
}

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** Replaces global fetch with one that streams `parts` back as the framed
 *  wire bytes. The bytes are handed to the reader exactly as chunked here,
 *  which is the whole point: this suite's job is to prove the client is
 *  indifferent to where the network happens to split them. */
function stubFetchWithFrames(
  parts: Uint8Array[],
  opts: { status?: number; jsonBody?: unknown; requestId?: string } = {}
) {
  const { status = 200, jsonBody, requestId = "req-1" } = opts;
  vi.stubGlobal("fetch", async () => {
    if (status !== 200) {
      return new Response(JSON.stringify(jsonBody ?? {}), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(streamOf(parts), {
      status: 200,
      headers: { "x-request-id": requestId },
    });
  });
}

interface Collected {
  chunks: string[];
  finalText?: string;
  metadata?: InventedMetadata;
  persisted?: boolean;
  error?: { kind: string; message: string; retryAfterMs?: number };
}

async function run(signal: AbortSignal = new AbortController().signal): Promise<Collected> {
  const collected: Collected = { chunks: [] };
  await streamGeneration(BODY, signal, {
    onChunk: (textSoFar) => collected.chunks.push(textSoFar),
    onDone: (finalText, metadata, persisted) => {
      collected.finalText = finalText;
      collected.metadata = metadata;
      collected.persisted = persisted;
    },
    onError: (error) => {
      collected.error = error;
    },
  });
  return collected;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamGeneration — framed protocol parsing", () => {
  it("reconstructs prose and metadata from a normal framed stream", async () => {
    const metadata = { theme: "noir", characters: "a detective" };
    const events: StreamEvent[] = [
      { event: "chunk", data: { text: "Once " } },
      { event: "chunk", data: { text: "upon a time." } },
      { event: "meta", data: { invented: metadata } },
      { event: "usage", data: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 5 } },
      { event: "done", data: { persisted: false } },
    ];
    stubFetchWithFrames([encodeAll(events)]);

    const got = await run();

    expect(got.error).toBeUndefined();
    expect(got.finalText).toBe("Once upon a time.");
    expect(got.metadata).toEqual(metadata);
    expect(got.chunks).toEqual(["Once ", "Once upon a time."]);
    expect(got.persisted).toBe(false);
  });

  it("passes a persisted: true done frame straight through to onDone", async () => {
    const events: StreamEvent[] = [
      { event: "chunk", data: { text: "Once upon a time." } },
      { event: "done", data: { persisted: true } },
    ];
    stubFetchWithFrames([encodeAll(events)]);

    const got = await run();

    expect(got.persisted).toBe(true);
  });

  it("reconstructs prose exactly for any split of the wire bytes, including mid-codepoint", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 0, maxLength: 40 }), { minLength: 1, maxLength: 6 }),
        fc.option(
          fc.record({
            theme: fc.string({ minLength: 1, maxLength: 30 }),
            characters: fc.string({ minLength: 1, maxLength: 30 }),
          }),
          { nil: undefined }
        ),
        fc.array(fc.nat(500), { maxLength: 12 }),
        async (chunkTexts, metadata, cutOffsets) => {
          const events: StreamEvent[] = [
            ...chunkTexts.map((text): StreamEvent => ({ event: "chunk", data: { text } })),
            { event: "meta", data: { invented: metadata } },
            { event: "done", data: { persisted: false } },
          ];
          const bytes = encodeAll(events);
          stubFetchWithFrames(splitBytes(bytes, cutOffsets));

          const got = await run();

          const expectedProse = chunkTexts.join("");
          expect(got.error).toBeUndefined();
          expect(got.finalText).toBe(expectedProse);
          expect(got.metadata).toEqual(metadata);
          // Every intermediate render is a prefix of the finished paragraph —
          // chunks arrive in order and nothing is duplicated or dropped.
          for (const shown of got.chunks) {
            expect(expectedProse.startsWith(shown)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("still applies a frame that carries no id, without advancing the resume cursor", async () => {
    // Not a shape this codebase's own server ever produces, but the SSE grammar
    // allows a dispatched block with no id: line at all — the parser must
    // still apply the event, just without anything to bump lastEventId to.
    const noIdFrame = new TextEncoder().encode('event: chunk\ndata: {"text":"hi"}\n\n');
    stubFetchWithFrames([noIdFrame, encodeAll([{ event: "done", data: { persisted: false } }], 1)]);

    const got = await run();

    expect(got.chunks).toEqual(["hi"]);
    expect(got.finalText).toBe("hi");
  });

  it("emits no metadata when the provider invented nothing", async () => {
    const events: StreamEvent[] = [
      { event: "chunk", data: { text: "Prose." } },
      { event: "meta", data: {} },
      { event: "done", data: { persisted: false } },
    ];
    stubFetchWithFrames([encodeAll(events)]);

    const got = await run();

    expect(got.finalText).toBe("Prose.");
    expect(got.metadata).toBeUndefined();
  });

  it("delivers a typed mid-stream error frame on a normally-closed stream, without needing to infer anything", async () => {
    const events: StreamEvent[] = [
      { event: "chunk", data: { text: "The story begins, " } },
      { event: "error", data: { kind: "stream-aborted", message: "Generation was interrupted before finishing.", retryable: true } },
    ];
    stubFetchWithFrames([encodeAll(events)]);

    const got = await run();

    expect(got.error).toEqual({
      kind: "stream-aborted",
      message: "Generation was interrupted before finishing.",
      failedProviderId: undefined,
      suggestedProviderId: undefined,
      suggestedProviderName: undefined,
    });
    expect(got.chunks).toEqual(["The story begins, "]);
    expect(got.finalText).toBeUndefined();
  });
});

describe("streamGeneration — pre-stream error mapping (unchanged: still a plain JSON body)", () => {
  it.each([
    [409, "turn-violation"],
    [429, "rate-limited"],
    [502, "provider-failed"],
    [400, "bad-request"],
    [500, "bad-request"],
  ])("maps HTTP %i to the %s error kind", async (status, kind) => {
    stubFetchWithFrames([], { status, jsonBody: { error: "server said no" } });

    const got = await run();

    expect(got.error).toEqual({ kind, message: "server said no" });
    expect(got.finalText).toBeUndefined();
  });

  it("falls back to a generic message when the JSON body carries no error field", async () => {
    stubFetchWithFrames([], { status: 400, jsonBody: { detail: "not the field we read" } });

    const got = await run();

    expect(got.error).toEqual({ kind: "bad-request", message: "Request failed (400)." });
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>gateway</html>", { status: 502 }));

    const got = await run();

    expect(got.error).toEqual({ kind: "provider-failed", message: "Request failed (502)." });
  });

  it("prefers the body's kind over the status-derived mapping, and carries the suggestion fields", async () => {
    stubFetchWithFrames([], {
      status: 502,
      jsonBody: {
        error: "Claude (Anthropic) isn't responding right now.",
        kind: "provider-unavailable",
        failedProviderId: "anthropic",
        suggestedProviderId: "openai",
        suggestedProviderName: "GPT-5 mini (OpenAI)",
      },
    });

    const got = await run();

    expect(got.error).toEqual({
      kind: "provider-unavailable",
      message: "Claude (Anthropic) isn't responding right now.",
      failedProviderId: "anthropic",
      suggestedProviderId: "openai",
      suggestedProviderName: "GPT-5 mini (OpenAI)",
    });
  });

  it("leaves the suggestion fields undefined when the body omits them (nothing else configured)", async () => {
    stubFetchWithFrames([], {
      status: 502,
      jsonBody: { error: "Fake isn't responding right now.", kind: "provider-unavailable", failedProviderId: "fake-provider" },
    });

    const got = await run();

    expect(got.error).toEqual({
      kind: "provider-unavailable",
      message: "Fake isn't responding right now.",
      failedProviderId: "fake-provider",
      suggestedProviderId: undefined,
      suggestedProviderName: undefined,
    });
  });

  it("carries the parsed Retry-After on a 429, in milliseconds", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        })
    );

    const got = await run();

    expect(got.error).toMatchObject({ kind: "rate-limited", retryAfterMs: 5000 });
  });

  it("leaves retryAfterMs undefined when the response carries no Retry-After header", async () => {
    stubFetchWithFrames([], { status: 429, jsonBody: { error: "slow down" } });

    const got = await run();

    expect(got.error).toMatchObject({ kind: "rate-limited" });
    expect(got.error?.retryAfterMs).toBeUndefined();
  });

  it("reports a network error when fetch itself throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    const got = await run();

    expect(got.error?.kind).toBe("network");
  });
});

describe("streamGeneration — abort handling (unchanged distinctions, docs/adr/0026)", () => {
  it("stays silent when the Writer aborts, rather than showing an error", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", async () => {
      controller.abort();
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    });

    const got = await run(controller.signal);

    expect(got.error).toBeUndefined();
    expect(got.finalText).toBeUndefined();
  });

  it("stays silent when the read is aborted mid-stream", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(streamController) {
              controller.abort();
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              streamController.error(err);
            },
          }),
          { status: 200, headers: { "x-request-id": "req-1" } }
        )
    );

    const got = await run(controller.signal);

    expect(got.error).toBeUndefined();
    expect(got.finalText).toBeUndefined();
  });

  it("surfaces a recoverable error when the browser aborts a fetch we never asked to cancel", async () => {
    // The actual shape of docs/adr/0026's finding: net::ERR_ABORTED throws an
    // AbortError-named exception without the request's own AbortSignal ever
    // being touched. This must surface as stream-aborted — StoryContext
    // already knows how to silently retry once on exactly that kind.
    vi.stubGlobal("fetch", async () => {
      const err = new Error("net::ERR_ABORTED");
      err.name = "AbortError";
      throw err;
    });

    const got = await run();

    expect(got.error).toMatchObject({
      kind: "stream-aborted",
      message: "Generation was interrupted before finishing.",
    });
  });
});

describe("streamGeneration — resume on transport failure (docs/adr/0043)", () => {
  it("attempts a resume once when the stream breaks mid-read, and succeeds", async () => {
    const initialEvents: StreamEvent[] = [{ event: "chunk", data: { text: "The story begins" } }];
    const resumeEvents: StreamEvent[] = [
      { event: "chunk", data: { text: ", and continues." } },
      { event: "meta", data: {} },
      { event: "done", data: { persisted: false } },
    ];

    let resumeCalled = false;
    let resumeLastEventIdHeader: string | null = null;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (RESUME_URL_RE.test(url)) {
        resumeCalled = true;
        resumeLastEventIdHeader = new Headers(init?.headers).get("Last-Event-ID");
        return new Response(streamOf([encodeAll(resumeEvents, 2)]), { status: 200 });
      }
      // The initial POST: one chunk, then the stream dies (a genuine
      // transport break — not our own signal, and not a typed error frame).
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeAll(initialEvents, 1));
          },
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "x-request-id": "req-1" } }
      );
    });

    const got = await run();

    expect(resumeCalled).toBe(true);
    expect(resumeLastEventIdHeader).toBe("1");
    expect(got.error).toBeUndefined();
    expect(got.finalText).toBe("The story begins, and continues.");
  });

  it("falls back to the generic stream-aborted error when resume also fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (RESUME_URL_RE.test(url)) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeAll([{ event: "chunk", data: { text: "The story begins" } }], 1));
          },
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "x-request-id": "req-1" } }
      );
    });

    const got = await run();

    expect(got.error?.kind).toBe("stream-aborted");
    expect(got.chunks).toEqual(["The story begins"]);
  });

  it("skips resume entirely when the response carries no x-request-id (e.g. Redis was never configured)", async () => {
    let fetchCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCallCount++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeAll([{ event: "chunk", data: { text: "one" } }], 1));
          },
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200 } // no x-request-id header
      );
    });

    const got = await run();

    expect(fetchCallCount).toBe(1); // never attempted a resume fetch
    expect(got.error?.kind).toBe("stream-aborted");
  });

  it("falls back to stream-aborted when the resume fetch itself throws (not an abort)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (RESUME_URL_RE.test(url)) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encodeAll([{ event: "chunk", data: { text: "one" } }], 1));
          },
          pull(c) {
            c.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "x-request-id": "req-1" } }
      );
    });

    const got = await run();

    expect(got.error?.kind).toBe("stream-aborted");
    expect(got.chunks).toEqual(["one"]);
  });

  it("stays silent when the Writer aborts during a resume attempt", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (RESUME_URL_RE.test(url)) {
        controller.abort();
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encodeAll([{ event: "chunk", data: { text: "one" } }], 1));
          },
          pull(c) {
            c.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "x-request-id": "req-1" } }
      );
    });

    const got = await run(controller.signal);

    expect(got.error).toBeUndefined();
    expect(got.finalText).toBeUndefined();
  });
});

describe("streamGeneration — an incomplete trailing frame", () => {
  it("drops a frame the stream never finished sending, rather than corrupting the prose", async () => {
    // The stream ends mid-frame (no terminating blank line ever arrives) —
    // this incomplete tail is simply never dispatched by the parser, and the
    // earlier, complete frames still land correctly.
    const complete = encodeAll([{ event: "chunk", data: { text: "Once upon a time." } }]);
    const incompleteTail = new TextEncoder().encode('id: 2\nevent: chunk\ndata: {"text":"more, but the connect');
    // No x-request-id header — this test is about frame parsing, not resume,
    // and omitting it (matching the "no Redis configured" case) keeps the
    // fallback path the only one this exercises.
    vi.stubGlobal("fetch", async () => new Response(streamOf([complete, incompleteTail]), { status: 200 }));

    const got = await run();

    // The already-complete chunk still rendered; no `done` frame ever
    // arrived (the incomplete tail never dispatches), so this is treated the
    // same as any other stream that closes without a terminal frame.
    expect(got.chunks).toEqual(["Once upon a time."]);
    expect(got.error?.kind).toBe("stream-aborted");
    expect(got.finalText).toBeUndefined();
  });
});
