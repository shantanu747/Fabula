import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyReports } from "@/lib/db/schema";

export async function POST(_request: Request, { params }: RouteContext<"/api/stories/[id]/report">) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const db = getDb();
  const [story] = await db.select().from(stories).where(eq(stories.id, id));
  if (!story || !story.isShared) {
    return Response.json({ error: "Story not found" }, { status: 404 });
  }

  // Unique(storyId, reporterId) makes a repeat report from the same reader a no-op,
  // not an error — there's no moderation queue in this pass to spam either way.
  await db
    .insert(storyReports)
    .values({ storyId: id, reporterId: session.user.id })
    .onConflictDoNothing();

  return Response.json({ ok: true });
}
