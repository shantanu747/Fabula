import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { createUser } from "@/test/factories";
import { sessionForUser, setTestSession } from "@/test/session";

/**
 * The idempotent-creation half of POST /api/stories
 * (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md) — depends on
 * the real UNIQUE(ownerId, idempotencyKey) constraint, so it runs against a
 * real Postgres rather than a stub.
 */

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/stories", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify({ targetLength: 10, selectedProviderId: "anthropic", ...body }),
  });
}

afterEach(() => {
  setTestSession(null);
});

describe("POST /api/stories — Idempotency-Key", () => {
  it("creates a story and returns 201 when no key is sent", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));

    const response = await POST(post({}));

    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(typeof id).toBe("string");
  });

  it("a replayed key from the same owner returns the existing row (200), inserting nothing new", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));
    const key = crypto.randomUUID();

    const first = await POST(post({ theme: "a lighthouse" }, { "Idempotency-Key": key }));
    expect(first.status).toBe(201);
    const { id: firstId } = await first.json();

    const second = await POST(post({ theme: "a different theme entirely" }, { "Idempotency-Key": key }));
    expect(second.status).toBe(200);
    const { id: secondId } = await second.json();

    expect(secondId).toBe(firstId);

    const rows = await getDb().select().from(stories).where(eq(stories.ownerId, user.id));
    expect(rows).toHaveLength(1);
    // The replay's body is never applied — the first request's row wins,
    // exactly like a real idempotent-creation replay should.
    expect(rows[0].theme).toBe("a lighthouse");
  });

  it("concurrent requests with the same key from the same owner produce exactly one row", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));
    const key = crypto.randomUUID();

    const responses = await Promise.all([
      POST(post({}, { "Idempotency-Key": key })),
      POST(post({}, { "Idempotency-Key": key })),
      POST(post({}, { "Idempotency-Key": key })),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ id: string }>));

    // Exactly one winner (201, a real insert); the other two are replays (200).
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    // Every response — winner and replays alike — names the same row.
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);

    const rows = await getDb().select().from(stories).where(eq(stories.ownerId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("the same key from two different owners never collides", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const key = crypto.randomUUID();

    setTestSession(sessionForUser(userA.id));
    const responseA = await POST(post({}, { "Idempotency-Key": key }));
    expect(responseA.status).toBe(201);

    setTestSession(sessionForUser(userB.id));
    const responseB = await POST(post({}, { "Idempotency-Key": key }));
    expect(responseB.status).toBe(201);

    const { id: idA } = await responseA.json();
    const { id: idB } = await responseB.json();
    expect(idA).not.toBe(idB);
  });

  it("an empty or oversized key falls back to an unconditional (non-idempotent) insert, exactly like no key at all", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));

    const empty1 = await POST(post({}, { "Idempotency-Key": "" }));
    const empty2 = await POST(post({}, { "Idempotency-Key": "" }));
    expect(empty1.status).toBe(201);
    expect(empty2.status).toBe(201);
    const { id: emptyId1 } = await empty1.json();
    const { id: emptyId2 } = await empty2.json();
    expect(emptyId1).not.toBe(emptyId2);

    const oversized = "x".repeat(201);
    const over1 = await POST(post({}, { "Idempotency-Key": oversized }));
    const over2 = await POST(post({}, { "Idempotency-Key": oversized }));
    expect(over1.status).toBe(201);
    expect(over2.status).toBe(201);
    const { id: overId1 } = await over1.json();
    const { id: overId2 } = await over2.json();
    expect(overId1).not.toBe(overId2);
  });

  it("two requests with no key at all still each create their own row (today's exact behavior, preserved)", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));

    const a = await POST(post({}));
    const b = await POST(post({}));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const { id: idA } = await a.json();
    const { id: idB } = await b.json();
    expect(idA).not.toBe(idB);
  });
});
