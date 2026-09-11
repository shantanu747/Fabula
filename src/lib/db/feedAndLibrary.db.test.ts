import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "./client";
import { users } from "./schema";
import {
  PAGE_SIZE,
  buildFeedQuery,
  buildLibraryQuery,
  decodeCursor,
  encodeCursor,
  getFeedPage,
  getLibraryPage,
} from "./feedAndLibrary";
import { createStory, createUser } from "@/test/factories";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor through encode and decode", () => {
    const cursor = { updatedAt: new Date("2026-01-01T12:34:56.789Z"), id: "story-1" };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not valid base64url at all", "!!!not-base64!!!"],
    ["no delimiter", Buffer.from("nodelimiterhere").toString("base64url")],
    ["an invalid date", Buffer.from("not-a-date|story-1").toString("base64url")],
    ["an empty id", Buffer.from("2026-01-01T00:00:00.000Z|").toString("base64url")],
  ])("rejects a malformed cursor (%s) rather than guessing a page boundary", (_label, raw) => {
    expect(decodeCursor(raw)).toBeUndefined();
  });
});

describe("getLibraryPage", () => {
  it("returns one Writer's stories newest-first, reading paragraphCount off the row", async () => {
    const user = await createUser();
    const older = await createStory(user.id, {
      updatedAt: new Date("2026-01-01"),
      paragraphCount: 3,
    });
    const newer = await createStory(user.id, {
      updatedAt: new Date("2026-01-02"),
      paragraphCount: 5,
    });

    const { rows, nextCursor } = await getLibraryPage(getDb(), user.id);

    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(rows.map((r) => r.paragraphCount)).toEqual([5, 3]);
    expect(nextCursor).toBeNull();
  });

  it("excludes another Writer's stories", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await createStory(a.id);
    const bStory = await createStory(b.id);

    const { rows } = await getLibraryPage(getDb(), b.id);

    expect(rows.map((r) => r.id)).toEqual([bStory.id]);
  });

  it("paginates with a keyset cursor, covering every story exactly once", async () => {
    const user = await createUser();
    const total = PAGE_SIZE + 5;
    const seeded = [];
    for (let i = 0; i < total; i++) {
      seeded.push(await createStory(user.id, { updatedAt: new Date(2026, 0, 1, 0, 0, i) }));
    }

    const page1 = await getLibraryPage(getDb(), user.id);
    expect(page1.rows).toHaveLength(PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();

    const cursor = decodeCursor(page1.nextCursor!)!;
    const page2 = await getLibraryPage(getDb(), user.id, cursor);
    expect(page2.rows).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const seenIds = [...page1.rows, ...page2.rows].map((r) => r.id);
    expect(new Set(seenIds).size).toBe(total); // no row skipped or repeated across the boundary
    expect(new Set(seenIds)).toEqual(new Set(seeded.map((s) => s.id)));
  });
});

describe("getFeedPage", () => {
  it("returns only shared stories, with the owner's display name", async () => {
    const user = await createUser();
    await getDb().update(users).set({ name: "A Writer" }).where(eq(users.id, user.id));
    const shared = await createStory(user.id, { isShared: true, paragraphCount: 2 });
    await createStory(user.id, { isShared: false });

    const { rows } = await getFeedPage(getDb());

    expect(rows.map((r) => r.id)).toEqual([shared.id]);
    expect(rows[0].authorName).toBe("A Writer");
    expect(rows[0].paragraphCount).toBe(2);
  });
});

describe("buildLibraryQuery / buildFeedQuery", () => {
  it("expose the underlying query builder for EXPLAIN (queries.perf.test.ts)", () => {
    const libraryQuery = buildLibraryQuery(getDb(), "some-owner");
    const feedQuery = buildFeedQuery(getDb());

    expect(typeof libraryQuery.toSQL).toBe("function");
    expect(typeof feedQuery.toSQL).toBe("function");
  });
});
