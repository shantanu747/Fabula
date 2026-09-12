import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setKvForTests } from "@/lib/kv/client";
import { createFakeResumeKv, throwingKv } from "@/test/kv";
import { createResumeBuffer, readResumeBuffer } from "./resumeBuffer";
import type { StreamEvent } from "./protocol";

const chunk = (text: string): StreamEvent => ({ event: "chunk", data: { text } });
const done = (): StreamEvent => ({ event: "done", data: { persisted: false } });

let originalKvUrl: string | undefined;

beforeEach(() => {
  originalKvUrl = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  __setKvForTests(undefined);
});

afterEach(() => {
  if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalKvUrl;
  __setKvForTests(undefined);
  vi.restoreAllMocks();
});

describe("createResumeBuffer / readResumeBuffer", () => {
  it("returns undefined for both create and read when Redis isn't configured", async () => {
    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    expect(handle).toBeUndefined();

    const record = await readResumeBuffer("req-1", "guest:1.2.3.4");
    expect(record).toBeUndefined();
  });

  it("round-trips events, in order with their ids, once Redis is configured", async () => {
    __setKvForTests(createFakeResumeKv());

    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    expect(handle).toBeDefined();
    await handle!.record(1, chunk("Once "));
    await handle!.record(2, chunk("upon a time."));
    await handle!.flush();

    const record = await readResumeBuffer("req-1", "guest:1.2.3.4");
    expect(record).toEqual({
      identity: "guest:1.2.3.4",
      events: [
        { id: 1, event: chunk("Once ") },
        { id: 2, event: chunk("upon a time.") },
      ],
      complete: false,
    });
  });

  it("throttles writes: fewer Redis set() calls than events recorded, below the batch size", async () => {
    const kv = createFakeResumeKv();
    const setSpy = vi.spyOn(kv, "set");
    __setKvForTests(kv);

    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    // The very first record always flushes (so a buffer exists in Redis from
    // the earliest possible moment — see createResumeBuffer's doc comment),
    // then fewer than FLUSH_EVERY_N_EVENTS (8) more with no time-based flush
    // in a tight loop.
    for (let i = 1; i <= 5; i++) await handle!.record(i, chunk(`chunk ${i} `));

    expect(setSpy).toHaveBeenCalledTimes(1);

    await handle!.flush();
    expect(setSpy).toHaveBeenCalledTimes(2);
  });

  it("flushes immediately on a terminal event, regardless of the batch threshold", async () => {
    const kv = createFakeResumeKv();
    const setSpy = vi.spyOn(kv, "set");
    __setKvForTests(kv);

    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    await handle!.record(1, chunk("one")); // the first record, so this alone already flushes
    expect(setSpy).toHaveBeenCalledTimes(1);
    await handle!.record(2, done());

    expect(setSpy).toHaveBeenCalledTimes(2);
    const record = await readResumeBuffer("req-1", "guest:1.2.3.4");
    expect(record?.complete).toBe(true);
  });

  it("flushes the very first record immediately, so a buffer exists in Redis from the start of a generation", async () => {
    const kv = createFakeResumeKv();
    const setSpy = vi.spyOn(kv, "set");
    __setKvForTests(kv);

    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    await handle!.record(1, chunk("one"));

    expect(setSpy).toHaveBeenCalledTimes(1);
    const record = await readResumeBuffer("req-1", "guest:1.2.3.4");
    expect(record?.events).toEqual([{ id: 1, event: chunk("one") }]);
  });

  it("flushes once the batch size is reached, without needing an explicit flush()", async () => {
    const kv = createFakeResumeKv();
    const setSpy = vi.spyOn(kv, "set");
    __setKvForTests(kv);

    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    // Record 1 flushes immediately (the "first write" rule); records 2-9 then
    // reach FLUSH_EVERY_N_EVENTS (8) pending and trigger the second flush.
    for (let i = 1; i <= 9; i++) await handle!.record(i, chunk(`c${i}`));

    expect(setSpy).toHaveBeenCalledTimes(2);
  });

  it("caps stored chunk text at the maximum plausible paragraph size, keeping terminal events", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");

    // Comfortably over MAX_RESUME_BUFFER_CHARS (20,000).
    const huge = "x".repeat(25_000);
    await handle!.record(1, chunk(huge));
    await handle!.record(2, chunk("more text after the cap"));
    await handle!.record(3, done());

    const record = await readResumeBuffer("req-1", "guest:1.2.3.4");
    // The oversized chunk itself crossed the cap when recorded, so it's the
    // first one dropped; the terminal event is always kept regardless.
    expect(record?.events.some((e) => e.event.event === "chunk")).toBe(false);
    expect(record?.events).toContainEqual({ id: 3, event: done() });
    expect(record?.complete).toBe(true);
  });

  it("rejects a foreign identity on resume — a requestId alone is not a capability", async () => {
    __setKvForTests(createFakeResumeKv());
    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");
    await handle!.record(1, done());

    const record = await readResumeBuffer("req-1", "guest:9.9.9.9");

    expect(record).toBeUndefined();
  });

  it("returns undefined, not a throw, when Redis errors on read", async () => {
    __setKvForTests(throwingKv());

    const record = await readResumeBuffer("req-1", "guest:1.2.3.4");

    expect(record).toBeUndefined();
  });

  it("does not throw when Redis errors on write — a lost buffer write degrades resume, not generation", async () => {
    __setKvForTests(throwingKv());
    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");

    await expect(handle!.record(1, done())).resolves.toBeUndefined();
  });

  it("flush() is a no-op when nothing is pending", async () => {
    const kv = createFakeResumeKv();
    const setSpy = vi.spyOn(kv, "set");
    __setKvForTests(kv);
    const handle = await createResumeBuffer("req-1", "guest:1.2.3.4");

    await handle!.flush();

    expect(setSpy).not.toHaveBeenCalled();
  });
});
