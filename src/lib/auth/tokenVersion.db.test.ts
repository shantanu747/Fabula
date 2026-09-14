import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { __setKvForTests } from "@/lib/kv/client";
import { neutralizeKvForEachTest, createFakeTokenVersionKv } from "@/test/kv";
import { assertSessionCurrent, bumpTokenVersion, getCurrentTokenVersion } from "./tokenVersion";

/**
 * Runs against a real Postgres (a fluent-builder select/update on `users`,
 * the same reason every other Drizzle-fluent module in this suite lives in
 * the db project). Exercises both the Postgres-only path and the
 * Redis-cache path against the same backing rows, since docs/adr/0047's
 * whole claim is that the two must always agree.
 */

async function createUser() {
  const [user] = await getDb().insert(users).values({ email: `writer-${crypto.randomUUID()}@example.com` }).returning();
  return user;
}

describe("getCurrentTokenVersion / bumpTokenVersion — Postgres only", () => {
  neutralizeKvForEachTest();

  it("reads the schema default (0) for a freshly created user", async () => {
    const user = await createUser();
    expect(await getCurrentTokenVersion(user.id)).toBe(0);
  });

  it("bumping increments the stored version", async () => {
    const user = await createUser();
    await bumpTokenVersion(user.id);
    expect(await getCurrentTokenVersion(user.id)).toBe(1);

    await bumpTokenVersion(user.id);
    expect(await getCurrentTokenVersion(user.id)).toBe(2);
  });

  it("reports undefined for a user id that doesn't exist — treated as revoked by every caller", async () => {
    expect(await getCurrentTokenVersion(crypto.randomUUID())).toBeUndefined();
  });
});

describe("getCurrentTokenVersion / bumpTokenVersion — Redis cache", () => {
  it("populates the cache on read and serves subsequent reads from it", async () => {
    __setKvForTests(createFakeTokenVersionKv());
    const user = await createUser();

    expect(await getCurrentTokenVersion(user.id)).toBe(0);

    // Mutate the row directly, bypassing bumpTokenVersion's own cache
    // invalidation — a cached read must still answer from the (now stale)
    // cache rather than re-querying Postgres on every call.
    await getDb().update(users).set({ tokenVersion: 99 }).where(eq(users.id, user.id));
    expect(await getCurrentTokenVersion(user.id)).toBe(0);

    __setKvForTests(undefined);
  });

  it("invalidates the cache on bump, so the next read reflects the new version", async () => {
    __setKvForTests(createFakeTokenVersionKv());
    const user = await createUser();

    await getCurrentTokenVersion(user.id); // populate the cache at version 0
    await bumpTokenVersion(user.id);

    expect(await getCurrentTokenVersion(user.id)).toBe(1);

    __setKvForTests(undefined);
  });
});

describe("assertSessionCurrent", () => {
  neutralizeKvForEachTest();

  it("returns null (proceed) when the session's version matches the live one", async () => {
    const user = await createUser();
    expect(await assertSessionCurrent({ id: user.id, tokenVersion: 0 })).toBeNull();
  });

  it("returns a 401 once the live version has moved past the session's", async () => {
    const user = await createUser();
    await bumpTokenVersion(user.id);

    const response = await assertSessionCurrent({ id: user.id, tokenVersion: 0 });
    expect(response?.status).toBe(401);
  });

  it("returns a 401 for a user that no longer exists", async () => {
    const response = await assertSessionCurrent({ id: crypto.randomUUID(), tokenVersion: 0 });
    expect(response?.status).toBe(401);
  });
});
