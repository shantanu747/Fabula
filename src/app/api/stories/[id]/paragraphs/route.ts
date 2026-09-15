import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories } from "@/lib/db/schema";
import { syncStoryParagraphs } from "@/lib/db/paragraphs";
import { invalidateFeedPage0Cache } from "@/lib/db/feedCache";
import { readJsonBody, STORY_BODY_MAX_BYTES } from "@/lib/http/readJsonBody";
import { isStoryParagraphArray } from "@/lib/story/validation";
import { guardStoriesWrite } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { assertSessionCurrent } from "@/lib/auth/tokenVersion";

/**
 * Persist-on-submit (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md):
 * mirrors what /api/generate's own diff-based sync already does for a
 * signed-in Writer's paragraphs, but reachable the instant `WRITER_SUBMIT`
 * fires — before, and independent of, whatever happens with the AI's turn.
 * Calls the exact same `syncStoryParagraphs` generation calls, unmodified,
 * so the UNIQUE(storyId, position) index stays the one serialization point
 * (ADRs 0013/0016) whichever path gets there first.
 */

interface SyncParagraphsBody {
  storySoFar: unknown;
}

function isValidBody(body: unknown): body is SyncParagraphsBody & { storySoFar: Parameters<typeof syncStoryParagraphs>[2] } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return isStoryParagraphArray(b.storySoFar);
}

export async function POST(request: Request, { params }: RouteContext<"/api/stories/[id]/paragraphs">) {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const revoked = await assertSessionCurrent(session.user);
  if (revoked) return revoked;
  const limited = await guardStoriesWrite(session.user.id);
  if (limited) return limited;
  const { id } = await params;

  const parsed = await readJsonBody(request, STORY_BODY_MAX_BYTES);
  if (!parsed.ok) return parsed.response;
  if (!isValidBody(parsed.body)) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.body;

  const db = getDb();
  // Explicit columns, not SELECT * — same shape as /api/generate's own lookup
  // (docs/adr/0041): paragraphCount/contentHash feed the sync fast path,
  // isShared decides whether a successful write needs a feed cache bust.
  const [story] = await db
    .select({
      id: stories.id,
      ownerId: stories.ownerId,
      paragraphCount: stories.paragraphCount,
      contentHash: stories.contentHash,
      isShared: stories.isShared,
    })
    .from(stories)
    .where(eq(stories.id, id));
  if (!story || story.ownerId !== session.user.id) {
    return Response.json({ error: "Story not found" }, { status: 404 });
  }

  const sync = await syncStoryParagraphs(db, story.id, body.storySoFar, {
    paragraphCount: story.paragraphCount,
    contentHash: story.contentHash,
  });
  if (!sync.ok) {
    return Response.json({ error: "Story content has diverged from server state" }, { status: 409 });
  }

  if (sync.appended > 0) {
    // The same "last touched" bump insertAIParagraph gives an AI turn
    // (src/lib/db/paragraphs.ts) — a separate statement here rather than
    // folded into appendParagraphsOnce itself, which is also /api/generate's
    // hot path and must not gain an unconditional extra write on every turn
    // for a bump this route needs unconditionally and that one already gets
    // from its own subsequent insertAIParagraph call.
    await db.update(stories).set({ updatedAt: new Date() }).where(eq(stories.id, story.id));
    // Best-effort and after the write, same posture as PATCH /api/stories/[id]:
    // a failed invalidation is recovered by the cache's own short TTL, and
    // must never turn a successful persist into an error.
    if (story.isShared) await invalidateFeedPage0Cache();
  }

  return Response.json({ ok: true });
}
