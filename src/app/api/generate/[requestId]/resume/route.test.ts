import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", async () => {
  const { getTestSession } = await import("@/test/session");
  return {
    auth: async () => getTestSession(),
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  };
});

import { GET } from "./route";
import { __setDbForTests } from "@/lib/db/client";
import { __setKvForTests } from "@/lib/kv/client";
import { createFakeResumeKv } from "@/test/kv";
import { setTestSession, sessionForUser } from "@/test/session";
import { createResumeBuffer } from "@/lib/streaming/resumeBuffer";
import { readAllFrames } from "@/test/sse";

function get(requestId: string, opts?: { lastEventId?: number; ip?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts?.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
  if (opts?.ip) headers["x-forwarded-for"] = opts.ip;
  return new Request(`http://localhost/api/generate/${requestId}/resume`, { headers });
}

function ctx(requestId: string) {
  return { params: Promise.resolve({ requestId }) };
}

let originalDatabaseUrl: string | undefined;
let originalKvUrl: string | undefined;

beforeEach(() => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  __setDbForTests(undefined);
  originalKvUrl = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  __setKvForTests(undefined);
  setTestSession(null);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalKvUrl;
  __setDbForTests(undefined);
  __setKvForTests(undefined);
  setTestSession(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GET /api/generate/[requestId]/resume — validation and authorization", () => {
  it("returns 404 for a requestId with an invalid shape, without ever touching Redis", async () => {
    __setKvForTests(createFakeResumeKv());

    const response = await GET(get("../not valid!!"), ctx("../not valid!!"));

    expect(response.status).toBe(404);
  });

  it("returns 404 when no buffer exists for the requestId (expired, wrong id, or no Redis at all)", async () => {
    __setKvForTests(createFakeResumeKv());

    const response = await GET(get("00000000-0000-0000-0000-000000000000"), ctx("00000000-0000-0000-0000-000000000000"));

    expect(response.status).toBe(404);
  });

  it("returns 404 for a buffer that belongs to a different guest identity — same as not found", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "done", data: { persisted: false } });

    const response = await GET(get("req-1", { ip: "198.51.100.4" }), ctx("req-1"));

    expect(response.status).toBe(404);
  });

  it("returns 404 for a buffer that belongs to a different signed-in user", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "user:owner-id");
    await handle!.record(1, { event: "done", data: { persisted: false } });
    setTestSession(sessionForUser("intruder-id"));

    const response = await GET(get("req-1"), ctx("req-1"));

    expect(response.status).toBe(404);
  });

  it("authorizes the matching signed-in user", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "user:owner-id");
    await handle!.record(1, { event: "done", data: { persisted: true } });
    setTestSession(sessionForUser("owner-id"));

    const response = await GET(get("req-1"), ctx("req-1"));

    expect(response.status).toBe(200);
  });
});

describe("GET /api/generate/[requestId]/resume — replay", () => {
  it("replays every buffered event when no Last-Event-ID is given", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "chunk", data: { text: "Once " } });
    await handle!.record(2, { event: "chunk", data: { text: "upon a time." } });
    await handle!.record(3, { event: "done", data: { persisted: false } });

    const response = await GET(get("req-1", { ip: "203.0.113.7" }), ctx("req-1"));
    const frames = await readAllFrames(response);

    expect(frames.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(frames.map((f) => f.event.event)).toEqual(["chunk", "chunk", "done"]);
  });

  it("replays only events after Last-Event-ID", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "chunk", data: { text: "Once " } });
    await handle!.record(2, { event: "chunk", data: { text: "upon a time." } });
    await handle!.record(3, { event: "done", data: { persisted: false } });

    const response = await GET(get("req-1", { ip: "203.0.113.7", lastEventId: 1 }), ctx("req-1"));
    const frames = await readAllFrames(response);

    expect(frames.map((f) => f.id)).toEqual([2, 3]);
  });

  it("closes the stream immediately when the buffer is already complete", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "done", data: { persisted: true, storyId: "story-1", position: 2 } });

    const response = await GET(get("req-1", { ip: "203.0.113.7" }), ctx("req-1"));
    const frames = await readAllFrames(response);

    expect(frames).toEqual([{ id: 1, event: { event: "done", data: { persisted: true, storyId: "story-1", position: 2 } } }]);
  });
});

describe("GET /api/generate/[requestId]/resume — live tail", () => {
  it("keeps polling and delivers new events written after the initial response, until complete", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "chunk", data: { text: "Once " } });

    const responsePromise = GET(get("req-1", { ip: "203.0.113.7" }), ctx("req-1"));

    // Simulates the original generation continuing to write to the buffer
    // while this resume request is already polling.
    await new Promise((r) => setTimeout(r, 50));
    await handle!.record(2, { event: "chunk", data: { text: "upon a time." } });
    await new Promise((r) => setTimeout(r, 50));
    await handle!.record(3, { event: "done", data: { persisted: false } });

    const response = await responsePromise;
    const frames = await readAllFrames(response);

    expect(frames.map((f) => f.id)).toEqual([1, 2, 3]);
  }, 10_000);

  it("sends a heartbeat while the generation is still incomplete during a long poll", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "chunk", data: { text: "one" } });
    vi.useFakeTimers();

    const responsePromise = GET(get("req-1", { ip: "203.0.113.7" }), ctx("req-1"));
    const response = await responsePromise;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const readLoop = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) raw += decoder.decode(value, { stream: true });
        if (done) break;
      }
    })();

    // Past HEARTBEAT_INTERVAL_MS (15s) with the buffer still incomplete.
    await vi.advanceTimersByTimeAsync(16_000);
    await handle!.record(2, { event: "done", data: { persisted: false } });
    await vi.advanceTimersByTimeAsync(1_000);
    await readLoop;

    expect(raw).toContain(": heartbeat");
  });

  it("gives up and closes once the wait bound elapses without the generation ever completing", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "chunk", data: { text: "one" } });
    vi.useFakeTimers();

    const response = await GET(get("req-1", { ip: "203.0.113.7" }), ctx("req-1"));
    const framesPromise = readAllFrames(response);
    // Comfortably past MAX_WAIT_MS (50s) — the buffer is never marked complete.
    await vi.advanceTimersByTimeAsync(60_000);
    const frames = await framesPromise;

    expect(frames.map((f) => f.id)).toEqual([1]);
  });

  it("stops polling once the client disconnects", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:203.0.113.7");
    await handle!.record(1, { event: "chunk", data: { text: "one" } });

    const response = await GET(get("req-1", { ip: "203.0.113.7" }), ctx("req-1"));
    const reader = response.body!.getReader();
    await reader.read(); // the initial buffered chunk
    // Never resolves on its own if polling doesn't actually stop — bounded by
    // the test timeout below rather than the route's own MAX_WAIT_MS.
    await expect(reader.cancel("done watching")).resolves.toBeUndefined();
  });
});
