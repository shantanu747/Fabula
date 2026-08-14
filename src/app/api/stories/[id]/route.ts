import { asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs } from "@/lib/db/schema";
import { isValidTargetLength } from "@/lib/story/validation";

export async function GET(_request: Request, { params }: RouteContext<"/api/stories/[id]">) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const db = getDb();
  const [story] = await db.select().from(stories).where(eq(stories.id, id));
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

  return Response.json({
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
  });
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
  const [story] = await db.select().from(stories).where(eq(stories.id, id));
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

  return Response.json({ ok: true });
}
