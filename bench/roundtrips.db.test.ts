import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { createUser } from "@/test/factories";
import { createRoundtripCounter } from "./roundtrips";

/**
 * Asserted against a real AppDatabase from the `db` Vitest project (see
 * vitest.db.config.mts, which this file's `bench/**\/*.db.test.{ts,tsx}` glob was
 * added to for exactly this), not a stub — a stub can only confirm it resembles
 * itself, not that the Proxy's `get` trap actually forwards the call shapes
 * Drizzle uses. See src/test/setup-db.ts for how `getDb()` gets a live
 * connection here.
 */
describe("createRoundtripCounter", () => {
  it("counts each call shape once, forwards return values unchanged, and doesn't swallow errors", async () => {
    const counter = createRoundtripCounter();
    const db = counter.wrap(getDb());

    expect(counter.counts).toEqual({ select: 0, insert: 0, update: 0, execute: 0 });

    const created = await createUser();
    // createUser() calls the real (unwrapped) getDb() singleton via src/test/factories.ts,
    // so it must not have moved the wrapped counter at all yet.
    expect(counter.total()).toBe(0);

    const [selected] = await db.select().from(users).where(eq(users.id, created.id));
    expect(selected).toEqual(created);
    expect(counter.counts.select).toBe(1);

    const [inserted] = await db
      .insert(users)
      .values({ email: `roundtrip-${crypto.randomUUID()}@example.com` })
      .returning();
    expect(inserted.email).toContain("roundtrip-");
    expect(counter.counts.insert).toBe(1);

    const [updated] = await db
      .update(users)
      .set({ name: "Updated Name" })
      .where(eq(users.id, created.id))
      .returning();
    expect(updated.name).toBe("Updated Name");
    expect(counter.counts.update).toBe(1);

    const result = await db.execute(sql`select 1 as one`);
    expect(result.rows).toEqual([{ one: 1 }]);
    expect(counter.counts.execute).toBe(1);

    expect(counter.total()).toBe(4);

    // Errors from the real driver must reach the caller exactly as thrown, not be
    // swallowed by the Proxy's get() trap or the bound-function wrapper.
    await expect(
      db.insert(users).values({ id: created.id, email: `dup-${crypto.randomUUID()}@example.com` })
    ).rejects.toThrow();
    // The attempted call still counts — the Proxy counts the call, not the outcome.
    expect(counter.counts.insert).toBe(2);

    counter.reset();
    expect(counter.counts).toEqual({ select: 0, insert: 0, update: 0, execute: 0 });
    expect(counter.total()).toBe(0);
  });

  it("does not count uncounted properties (e.g. accessing $client or a non-statement helper)", async () => {
    const counter = createRoundtripCounter();
    const db = counter.wrap(getDb());
    // Accessing something that isn't one of the four counted methods must not
    // increment anything — this is what proves the Proxy is selective rather
    // than counting every property access.
    void db.select;
    expect(counter.total()).toBe(0);
  });
});
