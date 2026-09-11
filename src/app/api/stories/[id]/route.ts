import { asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs } from "@/lib/db/schema";
import { invalidateFeedPage0Cache } from "@/lib/db/feedCache";
import { PRIVATE_NO_STORE } from "@/lib/http/cacheControl";
import { isValidTargetLength } from "@/lib/story/validation";
import { guardStoriesRead, guardStoriesWrite } from "@/lib/ratelimit/guard";

export async function GET(_request: Request, { params }: RouteContext<"/api/stories/[id]">) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const limited = await guardStoriesRead(session.user.id);
  if (limited) return limited;
  const { id } = await params;

  const db = getDb();
  // Explicit columns, not SELECT * — this handler doesn't need paragraphCount
  // or contentHash, which exist purely for the write path (docs/adr/0041).
  const [story] = await db
    .select({
      id: stories.id,
      ownerId: stories.ownerId,
      theme: stories.theme,
      characters: stories.characters,
      openingLines: stories.openingLines,
      targetLength: stories.targetLength,
      selectedProviderId: stories.selectedProviderId,
      invented: stories.invented,
      isShared: stories.isShared,
    })
    .from(stories)
    .where(eq(stories.id, id));
  if (!story || story.ownerId !== session.user.id) {
    return Response.json({ error: "Story not found" }, { status: 404 });
  }

  const paragraphs = await db
    .select({
      author: storyParagraphs.authorType,
      text: storyParagraphs.text,
      providerId: storyParagraphs.providerId,
    })
    .from(storyParagraphs)
    .where(eq(storyParagraphs.storyId, id))
    .orderBy(asc(storyParagraphs.position));

  return Response.json(
    {
      id: story.id,
      theme: story.theme ?? "",
      characters: story.characters ?? "",
      openingLines: story.openingLines ?? "",
      targetLength: story.targetLength,
      selectedProviderId: story.selectedProviderId,
      invented: story.invented ?? undefined,
      isShared: story.isShared,
      paragraphs: paragraphs.map((p) => ({
        author: p.author,
        text: p.text,
        providerId: p.providerId ?? undefined,
      })),
    },
    { headers: { "Cache-Control": PRIVATE_NO_STORE } }
  );
}

interface PatchStoryBody {
  isShared?: boolean;
  targetLength?: number;
}

function isValidPatchBody(body: unknown): body is PatchStoryBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    (b.isShared === undefined || typeof b.isShared === "boolean") &&
    (b.targetLength === undefined || isValidTargetLength(b.targetLength))
  );
}

export async function PATCH(request: Request, { params }: RouteContext<"/api/stories/[id]">) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const limited = await guardStoriesWrite(session.user.id);
  if (limited) return limited;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidPatchBody(body)) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const db = getDb();
  // Only the ownership check reads this row — explicit columns, not SELECT *.
  const [story] = await db
    .select({ id: stories.id, ownerId: stories.ownerId })
    .from(stories)
    .where(eq(stories.id, id));
  if (!story || story.ownerId !== session.user.id) {
    return Response.json({ error: "Story not found" }, { status: 404 });
  }

  await db
    .update(stories)
    .set({
      ...(body.isShared !== undefined ? { isShared: body.isShared } : {}),
      ...(body.targetLength !== undefined ? { targetLength: body.targetLength } : {}),
      updatedAt: new Date(),
    })
    .where(eq(stories.id, id));

  // Page 0 of the feed may have just gained, lost, or reordered a row
  // (docs/adr/0041). Best-effort and after the write, not gating the
  // response on it — a failed invalidation is recovered by the cache's own
  // short TTL, and must never turn a successful share-toggle into an error.
  if (body.isShared !== undefined) {
    await invalidateFeedPage0Cache();
  }

  return Response.json({ ok: true });
}
