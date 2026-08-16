import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { insertAIParagraph, isUniqueViolation, syncStoryParagraphs } from "./paragraphs";
import { stories, storyParagraphs } from "./schema";
import type { AppDatabase } from "./types";
import { createStory, createUser, readParagraphs, seedParagraphs } from "@/test/factories";
import { createBarrier, createGate } from "@/test/latch";
import type { StoryParagraph } from "@/lib/providers/types";

/**
 * The paragraph-position work against a real Postgres.
 *
 * These cannot be written against a fake. The property being tested is that the
 * *database* refuses to store two paragraphs at the same position, and that the
 * code reacts correctly when it does — a stubbed db would only ever assert that
 * the stub behaves like the stub.
 */

function writer(text: string): StoryParagraph {
  return { author: "writer", text };
}

function ai(text: string): StoryParagraph {
  return { author: "ai", text, providerId: "anthropic" };
}

async function newStory() {
  const user = await createUser();
  return createStory(user.id);
}

/**
 * Wraps the db so a spec can suspend a request at the moment between its read
 * and its write. That window is where the race lives; without a way to hold a
 * request open inside it, "concurrent" specs only ever pass by luck.
 */
function dbPausedBeforeWrite(hold: () => Promise<void>): AppDatabase {
  const real = getDb();
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (...args: unknown[]) => {
          await hold();
          return (target as unknown as Record<string, (...a: unknown[]) => unknown>).execute(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AppDatabase;
}

describe("the (storyId, position) unique constraint", () => {
  it("is actually present in the migrated schema", async () => {
    // Guards the migration, not the code. The constraint lived in schema.ts for
    // a while without its migration being listed in meta/_journal.json, so it
    // would never have reached a real database — everything else in this file
    // would still have passed.
    const story = await newStory();
    await seedParagraphs(story.id, [writer("first")]);

    await expect(
      getDb()
        .insert(storyParagraphs)
        .values({ storyId: story.id, authorType: "ai", text: "collision", position: 0 })
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("is scoped per story, so two stories can both have a position 0", async () => {
    const [a, b] = [await newStory(), await newStory()];

    await seedParagraphs(a.id, [writer("a0")]);
    await seedParagraphs(b.id, [writer("b0")]);

    await expect(readParagraphs(a.id)).resolves.toHaveLength(1);
    await expect(readParagraphs(b.id)).resolves.toHaveLength(1);
  });
});

describe("syncStoryParagraphs", () => {
  it("appends the client's new paragraphs at dense positions", async () => {
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one"), ai("two")]);

    const result = await syncStoryParagraphs(getDb(), story.id, [
      writer("one"),
      ai("two"),
      writer("three"),
    ]);

    expect(result).toEqual({ ok: true, storedBefore: 2, appended: 1, nextPosition: 3 });
    const rows = await readParagraphs(story.id);
    expect(rows.map((r) => [r.position, r.text])).toEqual([
      [0, "one"],
      [1, "two"],
      [2, "three"],
    ]);
  });

  it("adopts a guest's whole backlog in one call", async () => {
    // ADR 0009's guest-to-login path: the client arrives holding a story the
    // server has never seen, and the empty prefix check passes vacuously.
    const story = await newStory();

    const result = await syncStoryParagraphs(getDb(), story.id, [
      writer("one"),
      ai("two"),
      writer("three"),
    ]);

    expect(result).toMatchObject({ ok: true, storedBefore: 0, appended: 3, nextPosition: 3 });
    expect((await readParagraphs(story.id)).map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("is idempotent when the client re-sends what is already stored", async () => {
    // The client auto-retries once after a dropped stream. That retry must not
    // duplicate the Writer's paragraph.
    const story = await newStory();
    // Ends with a Writer paragraph because that is the only shape the route
    // forwards — an array ending in an AI turn is rejected as a 409 before
    // reaching here.
    const client = [writer("one"), ai("two"), writer("three")];
    await syncStoryParagraphs(getDb(), story.id, client);

    const second = await syncStoryParagraphs(getDb(), story.id, client);

    expect(second).toEqual({ ok: true, storedBefore: 3, appended: 0, nextPosition: 3 });
    expect(await readParagraphs(story.id)).toHaveLength(3);
  });

  it("rejects a client array that contradicts stored content", async () => {
    // The check a length comparison misses: same count, different history. A
    // stale second tab must not be able to rewrite the story.
    const story = await newStory();
    await seedParagraphs(story.id, [writer("what the server has")]);

    const result = await syncStoryParagraphs(getDb(), story.id, [
      writer("what the client claims"),
      ai("and its continuation"),
    ]);

    expect(result).toEqual({ ok: false, reason: "diverged" });
    expect(await readParagraphs(story.id)).toHaveLength(1);
  });

  it("rejects a client array shorter than what is stored", async () => {
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one"), ai("two"), writer("three")]);

    const result = await syncStoryParagraphs(getDb(), story.id, [writer("one")]);

    expect(result).toEqual({ ok: false, reason: "diverged" });
  });

  it("refuses to stack a second AI turn on a story already ending in one", async () => {
    // Only reachable if the mirror is corrupt, since the route rejects a client
    // array ending in an AI paragraph before it gets here. Defense in depth.
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one"), ai("two")]);

    const result = await syncStoryParagraphs(getDb(), story.id, [writer("one"), ai("two")]);

    expect(result).toEqual({ ok: false, reason: "diverged" });
  });
});

describe("insertAIParagraph", () => {
  it("writes the paragraph and touches the story's updatedAt", async () => {
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one")]);
    const before = story.updatedAt;

    const wrote = await insertAIParagraph(getDb(), {
      storyId: story.id,
      text: "the AI's reply",
      providerId: "anthropic",
      position: 1,
    });

    expect(wrote).toBe(true);
    const [updated] = await getDb().select().from(stories).where(eq(stories.id, story.id));
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("records invented metadata on the story when the AI made one up", async () => {
    const story = await newStory();

    await insertAIParagraph(getDb(), {
      storyId: story.id,
      text: "It rained.",
      providerId: "anthropic",
      position: 0,
      invented: { theme: "noir", characters: "a detective" },
    });

    const [updated] = await getDb().select().from(stories).where(eq(stories.id, story.id));
    expect(updated.invented).toEqual({ theme: "noir", characters: "a detective" });
  });

  it("stores UTC, not the session's local time", async () => {
    // The route writes updatedAt as `(now() at time zone 'utc')` because Drizzle
    // reads timestamps back as UTC. A bare now() would be cast using the session
    // TimeZone and land hours off.
    const story = await newStory();
    const beforeUtc = new Date();

    await insertAIParagraph(getDb(), {
      storyId: story.id,
      text: "x",
      providerId: "anthropic",
      position: 0,
    });

    const [updated] = await getDb().select().from(stories).where(eq(stories.id, story.id));
    expect(Math.abs(updated.updatedAt.getTime() - beforeUtc.getTime())).toBeLessThan(60_000);
  });

  it("reports failure without throwing when the position is already taken", async () => {
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one"), ai("already here")]);

    const wrote = await insertAIParagraph(getDb(), {
      storyId: story.id,
      text: "superseded",
      providerId: "anthropic",
      position: 1,
    });

    // A superseded generation is an outcome, not an error: the prose has already
    // streamed to the Writer, and failing here would break their stream.
    expect(wrote).toBe(false);
    expect((await readParagraphs(story.id))[1].text).toBe("already here");
  });

  it("leaves the story untouched when the insert was superseded", async () => {
    const story = await newStory();
    await seedParagraphs(story.id, [ai("already here")]);

    await insertAIParagraph(getDb(), {
      storyId: story.id,
      text: "superseded",
      providerId: "anthropic",
      position: 0,
      invented: { theme: "should not be recorded" },
    });

    const [updated] = await getDb().select().from(stories).where(eq(stories.id, story.id));
    expect(updated.invented).toBeNull();
  });
});

describe("concurrent turns on one story", () => {
  it("lets exactly one of two simultaneous AI paragraphs take a position", async () => {
    // Two tabs, or a double-submit. Both requests read the same max(position)
    // and both try to write it. Without the constraint both rows land and the
    // story silently grows two paragraph 2s.
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one")]);

    const barrier = createBarrier(2);
    const write = (text: string) =>
      insertAIParagraph(dbPausedBeforeWrite(() => barrier.arrive()), {
        storyId: story.id,
        text,
        providerId: "anthropic",
        position: 1,
      });

    const [first, second] = await Promise.all([write("from tab A"), write("from tab B")]);

    // Assert the invariant, not the ordering: which tab wins is genuinely
    // undetermined, and a spec that pinned it would be asserting scheduler luck.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const rows = await readParagraphs(story.id);
    expect(rows).toHaveLength(2);
    expect(["from tab A", "from tab B"]).toContain(rows[1].text);
  });

  it("recovers by re-reading when its append loses the race", async () => {
    // The loser must not fail the Writer's turn. It re-reads, sees the winner's
    // rows, and appends after them — so both paragraphs survive, in order, with
    // no gap and no duplicate position.
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one"), ai("two")]);

    const gate = createGate();
    let held = false;
    const slow = dbPausedBeforeWrite(async () => {
      if (held) return; // only the first write of the losing request waits
      held = true;
      await gate.wait();
    });

    const loser = syncStoryParagraphs(slow, story.id, [
      writer("one"),
      ai("two"),
      writer("from the slow tab"),
    ]);
    // Let the loser get past its read before the winner commits.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const winner = await syncStoryParagraphs(getDb(), story.id, [
      writer("one"),
      ai("two"),
      writer("from the fast tab"),
    ]);
    gate.open();
    const loserResult = await loser;

    expect(winner).toMatchObject({ ok: true, appended: 1, nextPosition: 3 });
    // The loser's client array contradicts what is now stored at position 2, so
    // it is correctly told the story diverged rather than interleaving into it.
    expect(loserResult).toEqual({ ok: false, reason: "diverged" });

    const rows = await readParagraphs(story.id);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows[2].text).toBe("from the fast tab");
  });

  it("keeps positions dense and unique under a burst of concurrent appends", async () => {
    // Ten tabs all appending the same next paragraph at once. Whatever the
    // interleaving, the story must end up with a contiguous 0..n-1 and no
    // duplicates — the invariant the whole design exists to hold.
    const story = await newStory();
    await seedParagraphs(story.id, [writer("one")]);

    const barrier = createBarrier(10);
    const attempts = Array.from({ length: 10 }, (_, i) =>
      insertAIParagraph(dbPausedBeforeWrite(() => barrier.arrive()), {
        storyId: story.id,
        text: `candidate ${i}`,
        providerId: "anthropic",
        position: 1,
      })
    );

    const results = await Promise.all(attempts);

    expect(results.filter(Boolean)).toHaveLength(1);
    const positions = (await readParagraphs(story.id)).map((r) => r.position);
    expect(positions).toEqual([0, 1]);
  });
});
