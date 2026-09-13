import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { createStory, createUser, readParagraphs } from "@/test/factories";
import { sessionForUser, setTestSession } from "@/test/session";
import type { StoryParagraph } from "@/lib/providers/types";

/**
 * Persist-on-submit's server side — depends on the real
 * UNIQUE(storyId, position) constraint syncStoryParagraphs serializes
 * against, so it runs against a real Postgres.
 */

function post(id: string, storySoFar: StoryParagraph[]): Request {
  return new Request(`http://localhost/api/stories/${id}/paragraphs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storySoFar }),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

afterEach(() => {
  setTestSession(null);
});

describe("POST /api/stories/[id]/paragraphs — auth and validation", () => {
  it("rejects an unauthenticated caller", async () => {
    setTestSession(null);
    const response = await POST(post(crypto.randomUUID(), []), ctx(crypto.randomUUID()));
    expect(response.status).toBe(401);
  });

  it("returns 404 for a story that does not exist", async () => {
    const user = await createUser();
    setTestSession(sessionForUser(user.id));
    const response = await POST(post(crypto.randomUUID(), []), ctx(crypto.randomUUID()));
    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for a story owned by someone else", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const story = await createStory(owner.id);
    setTestSession(sessionForUser(stranger.id));

    const response = await POST(post(story.id, []), ctx(story.id));

    expect(response.status).toBe(404);
  });

  it("rejects a malformed body", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));

    const request = new Request(`http://localhost/api/stories/${story.id}/paragraphs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storySoFar: "not an array" }),
    });
    const response = await POST(request, ctx(story.id));

    expect(response.status).toBe(400);
  });
});

describe("POST /api/stories/[id]/paragraphs — persistence", () => {
  it("persists a submitted Writer paragraph and bumps updatedAt", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    const before = story.updatedAt;

    const response = await POST(
      post(story.id, [{ author: "writer", text: "It was a dark and stormy night." }]),
      ctx(story.id)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const paragraphs = await readParagraphs(story.id);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toMatchObject({ authorType: "writer", text: "It was a dark and stormy night.", position: 0 });

    const [updated] = await getDb().select().from(stories).where(eq(stories.id, story.id));
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(updated.paragraphCount).toBe(1);
  });

  it("is idempotent — replaying the exact same array a second time creates no duplicate rows", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));
    const draft: StoryParagraph[] = [{ author: "writer", text: "Once upon a time." }];

    const first = await POST(post(story.id, draft), ctx(story.id));
    const second = await POST(post(story.id, draft), ctx(story.id));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const paragraphs = await readParagraphs(story.id);
    expect(paragraphs).toHaveLength(1);
  });

  it("appends only the new tail when called again with more paragraphs", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));

    await POST(post(story.id, [{ author: "writer", text: "First." }]), ctx(story.id));
    const response = await POST(
      post(story.id, [
        { author: "writer", text: "First." },
        { author: "ai", text: "Second, by the AI.", providerId: "anthropic" },
        { author: "writer", text: "Third." },
      ]),
      ctx(story.id)
    );

    expect(response.status).toBe(200);
    const paragraphs = await readParagraphs(story.id);
    expect(paragraphs.map((p) => p.text)).toEqual(["First.", "Second, by the AI.", "Third."]);
  });

  it("returns 409 when the client's array contradicts what's already stored", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));

    await POST(post(story.id, [{ author: "writer", text: "The real opening." }]), ctx(story.id));
    const response = await POST(
      post(story.id, [{ author: "writer", text: "A completely different opening." }]),
      ctx(story.id)
    );

    expect(response.status).toBe(409);
    // Nothing from the diverged request landed.
    const paragraphs = await readParagraphs(story.id);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].text).toBe("The real opening.");
  });

  it("concurrent submissions of the same growing draft still produce a clean, position-consistent story", async () => {
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));

    const responses = await Promise.all([
      POST(post(story.id, [{ author: "writer", text: "Paragraph one." }]), ctx(story.id)),
      POST(post(story.id, [{ author: "writer", text: "Paragraph one." }]), ctx(story.id)),
      POST(post(story.id, [{ author: "writer", text: "Paragraph one." }]), ctx(story.id)),
    ]);

    for (const response of responses) expect(response.status).toBe(200);
    const paragraphs = await readParagraphs(story.id);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].position).toBe(0);
  });

  it("never persisted-before generation: a submitted paragraph is in the database with no /api/generate call involved", async () => {
    // The literal data-loss bug this route exists to close — a paragraph is
    // durable the moment this call resolves, independent of whether any
    // generation ever happens afterward.
    const user = await createUser();
    const story = await createStory(user.id);
    setTestSession(sessionForUser(user.id));

    const response = await POST(post(story.id, [{ author: "writer", text: "Written, then the tab closes." }]), ctx(story.id));

    expect(response.status).toBe(200);
    const paragraphs = await readParagraphs(story.id);
    expect(paragraphs.map((p) => p.text)).toEqual(["Written, then the tab closes."]);
  });
});
