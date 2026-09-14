import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoryCreationCoordinator, persistParagraphs } from "./persistence";
import { NETWORK_RETRY_POLICY } from "./retry";

const INPUT = { targetLength: 10, selectedProviderId: "anthropic" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Drains every pending backoff sleep so a retrying call settles under fake timers. */
async function drain<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe("createStoryCreationCoordinator — ensureStoryId", () => {
  it("returns the created id on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    const result = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    expect(result).toBe("story-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends an Idempotency-Key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });

  it("concurrent calls within the same tick share one in-flight request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    const [a, b] = await Promise.all([
      drain(coordinator.ensureStoryId(INPUT, fetchImpl)),
      coordinator.ensureStoryId(INPUT, fetchImpl),
    ]);

    expect(a).toBe("story-1");
    expect(b).toBe("story-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses the same key across separate, sequential attempts toward one logical creation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(500, {})); // exhausts NETWORK_RETRY_POLICY.maxAttempts (3)
    const coordinator = createStoryCreationCoordinator();

    const first = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));
    expect(first).toBeUndefined();

    fetchImpl.mockResolvedValueOnce(jsonResponse(201, { id: "story-1" }));
    const second = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));
    expect(second).toBe("story-1");

    const keys = fetchImpl.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (init.headers as Record<string, string>)["Idempotency-Key"];
    });
    expect(new Set(keys).size).toBe(1); // every attempt, across both calls, used the same key
  });

  it("reset() starts a fresh key on the next call", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    await drain(coordinator.ensureStoryId(INPUT, fetchImpl));
    coordinator.reset();
    await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2); // one clean attempt per logical creation
    const keys = fetchImpl.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (init.headers as Record<string, string>)["Idempotency-Key"];
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("retries a 5xx with backoff and succeeds once the server recovers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    const result = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    expect(result).toBe("story-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown network error and succeeds once the connection recovers", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    const result = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    expect(result).toBe("story-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("resolves undefined, not a rejection, once every retry is exhausted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const coordinator = createStoryCreationCoordinator();

    const result = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    expect(result).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(NETWORK_RETRY_POLICY.maxAttempts);
  });

  it("never retries a 4xx — the request itself is wrong, not the connection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Not authenticated" }));
    const coordinator = createStoryCreationCoordinator();

    const result = await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    expect(result).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the in-flight guard clears after settling, so a later call starts a new request", async () => {
    // mockImplementation, not mockResolvedValue with a single shared Response —
    // a Response body can only be read once, and this test's whole point is
    // driving ensureStoryId twice.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(201, { id: "story-1" }));
    const coordinator = createStoryCreationCoordinator();

    await drain(coordinator.ensureStoryId(INPUT, fetchImpl));
    await drain(coordinator.ensureStoryId(INPUT, fetchImpl));

    // Both calls resolve the same story, but the second still short-circuits
    // through StoryContext's own `if (state.storyId) return` in real usage;
    // this module has no opinion on that — it just proves it isn't stuck
    // "in flight" forever after the first settles.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("persistParagraphs", () => {
  const PARAGRAPHS = [{ author: "writer" as const, text: "Once upon a time." }];

  it("returns true on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    const result = await drain(persistParagraphs("story-1", PARAGRAPHS, fetchImpl));

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/stories/story-1/paragraphs",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("retries a 5xx and returns true once it succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await drain(persistParagraphs("story-1", PARAGRAPHS, fetchImpl));

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown network error and returns true once it succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await drain(persistParagraphs("story-1", PARAGRAPHS, fetchImpl));

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns false immediately on a 409 (diverged) — retrying can't fix a content mismatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(409, { error: "diverged" }));

    const result = await drain(persistParagraphs("story-1", PARAGRAPHS, fetchImpl));

    expect(result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns false once every retry against a persistent 5xx is exhausted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));

    const result = await drain(persistParagraphs("story-1", PARAGRAPHS, fetchImpl));

    expect(result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(NETWORK_RETRY_POLICY.maxAttempts);
  });
});
