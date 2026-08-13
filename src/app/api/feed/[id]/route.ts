import { asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs, users } from "@/lib/db/schema";

export async function GET(_request: Request, { params }: RouteContext<"/api/feed/[id]">) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const db = getDb();
  const [row] = await db
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      isShared: stories.isShared,
      updatedAt: stories.updatedAt,
      authorName: users.name,
    })
    .from(stories)
    .innerJoin(users, eq(users.id, stories.ownerId))
    .where(eq(stories.id, id));

  if (!row || !row.isShared) {
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
    id: row.id,
    theme: row.theme,
    characters: row.characters,
    authorName: row.authorName,
    updatedAt: row.updatedAt,
    paragraphs,
  });
}
