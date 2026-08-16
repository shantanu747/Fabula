import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { __setDbForTests, getDb } from "@/lib/db/client";
import type { AppDatabase } from "@/lib/db/types";
import { PROVIDERS } from "@/lib/providers/registry";
import type { LLMProvider } from "@/lib/providers/types";
import { createStory, createUser, readParagraphs, seedParagraphs } from "@/test/factories";
import { sessionForUser, setTestSession } from "@/test/session";
import { createBarrier } from "@/test/latch";
import { GENERATE_GUEST } from "@/lib/ratelimit/policy";

/**
 * The persisted half of /api/generate — the path the guest specs in
 * route.test.ts deliberately never touch. Everything here depends on what the
 * database does under concurrency, so it runs against a real Postgres.
 */

const FAKE_ID = "fake-provider";

function installFake(options: { chunks?: string[]; beforeReturn?: () => Promise<void> } = {}) {
  const { chunks = ["The AI's paragraph."], beforeReturn } = options;
  const provider: LLMProvider = {
    id: FAKE_ID,
    displayName: "Fake",
    async *generateParagraph() {
      for (const chunk of chunks) yield chunk;
      // Lets a spec hold every in-flight generation open until they have all
      // reached the same point, so their persistence genuinely overlaps.
      if (beforeReturn) await beforeReturn();
      return undefined;
    },
  };
  PROVIDERS[FAKE_ID] = provider;
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: FAKE_ID, ...body }),
  });
}

const writer = (text: string) => ({ author: "writer" as const, text });
const ai = (text: string) => ({ author: "ai" as const, text, providerId: FAKE_ID });

beforeEach(() => {
  installFake();
});

afterEach(() => {
  delete PROVIDERS[FAKE_ID];
  setTestSession(null);
  vi.restoreAllMocks();
});

describe("POST /api/generate — authorization of a persisted story", () => {
  it("rejects a storyId from a signed-out caller", async () => {
    setTestSession(null);

    const response = await POST(post({ storySoFar: [], storyId: crypto.randomUUID() }));

    expect(response.status).toBe(401);
  });

  it("returns 404 for a story that does not exist", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));

    const response = await POST(post({ storySoFar: [], storyId: crypto.randomUUID() }));

    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for a story owned by someone else", async () => {
    // Ownership is re-checked here rather than trusted from the client, and a
    // stranger's story is reported as absent so the endpoint cannot be used to
    // confirm that a given story id exists.
    const [owner, intruder] = [await createUser(), await createUser()];
    const story = await createStory(owner.id);
    setTestSession(sessionForUser(intruder.id));

    const response = await POST(post({ storySoFar: [], storyId: story.id }));

    expect(response.status).toBe(404);
  });
});

describe("POST /api/generate — write-through persistence", () => {
  it("stores the Writer's new paragraph and the AI's reply", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    await seedParagraphs(story.id, [writer("one"), ai("two")]);

    const response = await POST(
      post({ storySoFar: [writer("one"), ai("two"), writer("three")], storyId: story.id })
    );
    await response.text();

    const rows = await readParagraphs(story.id);
    expect(rows.map((r) => [r.position, r.authorType, r.text])).toEqual([
      [0, "writer", "one"],
      [1, "ai", "two"],
      [2, "writer", "three"],
      [3, "ai", "The AI's paragraph."],
    ]);
  });

  it("derives the AI's position from the database, not from the client's array length", async () => {
    // The original bug: position came from input.storySoFar.length, so a client
    // holding a stale or trimmed array placed the AI paragraph on top of an
    // existing one.
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    await seedParagraphs(story.id, [writer("one"), ai("two"), writer("three")]);

    const response = await POST(
      post({ storySoFar: [writer("one"), ai("two"), writer("three")], storyId: story.id })
    );
    await response.text();

    const rows = await readParagraphs(story.id);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ position: 3, authorType: "ai" });
  });

  it("rejects a client whose story contradicts the stored one", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    await seedParagraphs(story.id, [writer("what the server has")]);

    const response = await POST(
      post({ storySoFar: [writer("what the client claims")], storyId: story.id })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Story content has diverged from server state",
    });
    expect(await readParagraphs(story.id)).toHaveLength(1);
  });

  it("does not persist anything for a guest, even with a session present", async () => {
    // Omitting storyId is what makes a request a guest request. Logged-in
    // Writers who have not saved yet take exactly the same path.
    const user = await createUser();
    setTestSession(sessionForUser(user.id));

    const response = await POST(post({ storySoFar: [writer("one")] }));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("The AI's paragraph.");
  });

  it("still delivers the paragraph when the mirror write fails", async () => {
    // The Writer has already watched this paragraph appear. Failing the stream
    // over a database blip would make the client auto-retry and pay for a second
    // generation of a paragraph that already succeeded.
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    // Stored already equals what the client sends, so the only write attempted
    // is the AI paragraph's.
    await seedParagraphs(story.id, [writer("one")]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const real = getDb();
    // The route runs exactly two `execute` statements on this path: the rate
    // limiter's token upsert, then the AI paragraph insert. Only the second is
    // failed — breaking the first would make the request 429 (the limiter fails
    // closed by design) and never reach the behaviour under test.
    let executeCalls = 0;
    __setDbForTests(
      new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "execute") {
            return async (...args: unknown[]) => {
              if (++executeCalls > 1) throw new Error("database is down");
              return (target as unknown as Record<string, (...a: unknown[]) => unknown>).execute(
                ...args
              );
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as AppDatabase
    );

    try {
      const response = await POST(post({ storySoFar: [writer("one")], storyId: story.id }));

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("The AI's paragraph.");
    } finally {
      __setDbForTests(real);
    }

    // The mirror lost the paragraph; the story did not.
    expect(await readParagraphs(story.id)).toHaveLength(1);
  });
});

describe("POST /api/generate — rate limiting", () => {
  function guestPost(ip: string) {
    return new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ providerId: FAKE_ID, storySoFar: [] }),
    });
  }

  it("stops an anonymous caller once the burst is spent", async () => {
    // Without this the endpoint is an open, unauthenticated way to spend the
    // operator's provider budget: MAX_OUTPUT_TOKENS caps one call, not a
    // thousand of them.
    setTestSession(null);

    const statuses: number[] = [];
    for (let i = 0; i < GENERATE_GUEST.capacity + 1; i++) {
      const response = await POST(guestPost("203.0.113.7"));
      statuses.push(response.status);
      await response.text().catch(() => {});
    }

    expect(statuses.slice(0, GENERATE_GUEST.capacity)).toEqual(
      Array(GENERATE_GUEST.capacity).fill(200)
    );
    expect(statuses[GENERATE_GUEST.capacity]).toBe(429);
  });

  it("tells the caller how long to wait", async () => {
    setTestSession(null);
    for (let i = 0; i < GENERATE_GUEST.capacity; i++) {
      await (await POST(guestPost("203.0.113.7"))).text();
    }

    const denied = await POST(guestPost("203.0.113.7"));

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("does not let one address exhaust another's budget", async () => {
    setTestSession(null);
    for (let i = 0; i < GENERATE_GUEST.capacity + 1; i++) {
      await (await POST(guestPost("203.0.113.7"))).text().catch(() => {});
    }

    const other = await POST(guestPost("198.51.100.4"));

    expect(other.status).toBe(200);
  });

  it("budgets a signed-in Writer by account, not by address", async () => {
    // Otherwise a household sharing one connection would share one budget, which
    // is exactly the pair of people the PRD describes co-writing on a tablet.
    const user = await createUser();
    setTestSession(sessionForUser(user.id));

    const statuses: number[] = [];
    for (let i = 0; i < GENERATE_GUEST.capacity + 1; i++) {
      const response = await POST(guestPost("203.0.113.7"));
      statuses.push(response.status);
      await response.text().catch(() => {});
    }

    // Past the guest allowance, because the signed-in policy is more generous.
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("refuses out of turn without spending a token", async () => {
    // A client bug that hammers an out-of-turn request should not burn through
    // the Writer's real budget, since the request never reaches a provider.
    setTestSession(null);
    const outOfTurn = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({
        providerId: FAKE_ID,
        storySoFar: [{ author: "ai", text: "The AI just wrote." }],
      }),
    });

    for (let i = 0; i < GENERATE_GUEST.capacity + 3; i++) {
      expect((await POST(outOfTurn.clone())).status).toBe(409);
    }

    // The full burst is still available afterwards.
    expect((await POST(guestPost("203.0.113.7"))).status).toBe(200);
  });
});

describe("POST /api/generate — two turns racing on one story", () => {
  it("persists exactly one AI paragraph while both Writers still see their prose", async () => {
    // A double-submit, or the same story open in two tabs. Both requests read
    // the same story state and both compute the same next position, so both try
    // to write it. The loser's generation is superseded — but its stream must
    // still complete, because that Writer already watched the text arrive.
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    await seedParagraphs(story.id, [writer("one")]);

    // Holds both generations open until each has finished streaming, so their
    // persistence overlaps instead of running one after the other.
    const barrier = createBarrier(2);
    installFake({ beforeReturn: () => barrier.arrive() });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const bodies = await Promise.all(
      [1, 2].map(async () => {
        const response = await POST(post({ storySoFar: [writer("one")], storyId: story.id }));
        return response.text();
      })
    );

    expect(bodies).toEqual(["The AI's paragraph.", "The AI's paragraph."]);

    const rows = await readParagraphs(story.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });
});
