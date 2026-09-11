import { afterEach, describe, expect, it } from "vitest";
import type { Redis } from "@upstash/redis";
import { __setKvForTests } from "@/lib/kv/client";
import { neutralizeKvForEachTest, throwingKv } from "@/test/kv";
import { createStory, createUser } from "@/test/factories";
import { getDb } from "./client";
import { getCachedFeedPage0, invalidateFeedPage0Cache } from "./feedCache";

/** A minimal in-memory get/set/del stand-in, same shape as the budget and
 *  admission fakes in src/test/kv.ts — this module only ever uses those three
 *  commands. */
function createFakeCacheKv(): Redis {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    },
  } as unknown as Redis;
}

describe("getCachedFeedPage0 — Redis absent", () => {
  neutralizeKvForEachTest();

  it("falls straight through to a real query when hasKv() is false", async () => {
    const user = await createUser();
    const shared = await createStory(user.id, { isShared: true });

    const { rows } = await getCachedFeedPage0(getDb());

    expect(rows.map((r) => r.id)).toEqual([shared.id]);
  });

  it("does nothing (no throw) when invalidated with no Redis configured", async () => {
    await expect(invalidateFeedPage0Cache()).resolves.toBeUndefined();
  });
});

describe("getCachedFeedPage0 — Redis configured", () => {
  afterEach(() => {
    __setKvForTests(undefined);
  });

  it("serves a cache hit without querying the database again", async () => {
    const user = await createUser();
    const shared = await createStory(user.id, { isShared: true });
    __setKvForTests(createFakeCacheKv());

    const first = await getCachedFeedPage0(getDb());
    expect(first.rows.map((r) => r.id)).toEqual([shared.id]);

    // A story shared after the first read must NOT appear yet — proves the
    // second call was actually served from cache, not from a fresh query.
    await createStory(user.id, { isShared: true });
    const second = await getCachedFeedPage0(getDb());

    expect(second.rows.map((r) => r.id)).toEqual([shared.id]);
  });

  it("invalidation makes the next read see fresh data again", async () => {
    const user = await createUser();
    const first = await createStory(user.id, { isShared: true });
    __setKvForTests(createFakeCacheKv());

    await getCachedFeedPage0(getDb());
    const second = await createStory(user.id, { isShared: true, updatedAt: new Date() });

    await invalidateFeedPage0Cache();
    const { rows } = await getCachedFeedPage0(getDb());

    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(rows).toHaveLength(2);
  });

  it("never breaks the page when Redis throws on every call (docs/adr/0035)", async () => {
    const user = await createUser();
    const shared = await createStory(user.id, { isShared: true });
    __setKvForTests(throwingKv());

    const { rows } = await getCachedFeedPage0(getDb());

    expect(rows.map((r) => r.id)).toEqual([shared.id]);
    await expect(invalidateFeedPage0Cache()).resolves.toBeUndefined();
  });
});
