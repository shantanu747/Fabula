import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db/client";
import { storyReports } from "@/lib/db/schema";
import { createStory, createUser } from "@/test/factories";
import { sessionForUser, setTestSession } from "@/test/session";
import { bumpTokenVersion } from "@/lib/auth/tokenVersion";

function report(id: string, origin = "http://localhost"): Request {
  return new Request(`http://localhost/api/stories/${id}/report`, {
    method: "POST",
    headers: { Origin: origin },
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

afterEach(() => setTestSession(null));

describe("POST /api/stories/[id]/report — origin (docs/adr/0048)", () => {
  it("rejects a cross-origin request — the exact CORS-simple-request exposure this route had", async () => {
    const owner = await createUser();
    const story = await createStory(owner.id, { isShared: true });
    const reporter = await createUser();
    setTestSession(sessionForUser(reporter.id));

    const response = await POST(report(story.id, "https://evil.example"), ctx(story.id));
    expect(response.status).toBe(403);

    const rows = await getDb().select().from(storyReports).where(eq(storyReports.storyId, story.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects a request with no Origin header at all", async () => {
    const owner = await createUser();
    const story = await createStory(owner.id, { isShared: true });
    const reporter = await createUser();
    setTestSession(sessionForUser(reporter.id));

    const response = await POST(new Request(`http://localhost/api/stories/${story.id}/report`, { method: "POST" }), ctx(story.id));
    expect(response.status).toBe(403);
  });

  it("allows a same-origin report through", async () => {
    const owner = await createUser();
    const story = await createStory(owner.id, { isShared: true });
    const reporter = await createUser();
    setTestSession(sessionForUser(reporter.id));

    const response = await POST(report(story.id), ctx(story.id));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/stories/[id]/report — session revocation", () => {
  it("rejects a session whose tokenVersion no longer matches the live one", async () => {
    const owner = await createUser();
    const story = await createStory(owner.id, { isShared: true });
    const reporter = await createUser();
    setTestSession(sessionForUser(reporter.id, { tokenVersion: 0 }));
    await bumpTokenVersion(reporter.id);

    const response = await POST(report(story.id), ctx(story.id));
    expect(response.status).toBe(401);
  });
});
