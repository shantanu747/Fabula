import { count, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs, users } from "@/lib/db/schema";

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

  const rows = await getDb()
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      updatedAt: stories.updatedAt,
      authorName: users.name,
      paragraphCount: count(storyParagraphs.id),
    })
    .from(stories)
    .innerJoin(users, eq(users.id, stories.ownerId))
    .leftJoin(storyParagraphs, eq(storyParagraphs.storyId, stories.id))
    .where(eq(stories.isShared, true))
    .groupBy(stories.id, users.name)
    .orderBy(desc(stories.updatedAt))
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  const hasMore = rows.length > PAGE_SIZE;
  return Response.json({
    stories: rows.slice(0, PAGE_SIZE),
    nextOffset: hasMore ? offset + PAGE_SIZE : null,
  });
}
