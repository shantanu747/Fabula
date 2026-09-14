import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PATCH } from "./route";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { createStory, createUser } from "@/test/factories";
import { sessionForUser, setTestSession } from "@/test/session";
import { bumpTokenVersion } from "@/lib/auth/tokenVersion";

function patch(id: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/stories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

afterEach(() => setTestSession(null));

describe("PATCH /api/stories/[id] — origin", () => {
  it("rejects a cross-origin request", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));

    const response = await PATCH(
      patch(story.id, { isShared: true }, { Origin: "https://evil.example" }),
      ctx(story.id)
    );
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/stories/[id] — session revocation", () => {
  it("rejects a session whose tokenVersion no longer matches the live one", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id, { tokenVersion: 0 }));
    await bumpTokenVersion(user.id);

    const response = await PATCH(patch(story.id, { targetLength: 12 }), ctx(story.id));
    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/stories/[id] — the verification gate (docs/adr/0046)", () => {
  it("blocks sharing for an unverified Writer", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id, { verified: false }));

    const response = await PATCH(patch(story.id, { isShared: true }), ctx(story.id));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.reason).toBe("unverified");

    const [row] = await getDb().select({ isShared: stories.isShared }).from(stories).where(eq(stories.id, story.id));
    expect(row.isShared).toBe(false);
  });

  it("allows an unverified Writer to un-share (isShared: false) — only the transition to shared is gated", async () => {
    const user = await createUser();
    const story = await createStory(user.id, { isShared: true });
    setTestSession(sessionForUser(user.id, { verified: false }));

    const response = await PATCH(patch(story.id, { isShared: false }), ctx(story.id));
    expect(response.status).toBe(200);
  });

  it("allows an unverified Writer to change targetLength — writing is never gated", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id, { verified: false }));

    const response = await PATCH(patch(story.id, { targetLength: 20 }), ctx(story.id));
    expect(response.status).toBe(200);
  });

  it("allows a verified Writer to share", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id, { verified: true }));

    const response = await PATCH(patch(story.id, { isShared: true }), ctx(story.id));
    expect(response.status).toBe(200);

    const [row] = await getDb().select({ isShared: stories.isShared }).from(stories).where(eq(stories.id, story.id));
    expect(row.isShared).toBe(true);
  });
});
