import Link from "next/link";
import { count, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs } from "@/lib/db/schema";
import { AppHeader } from "@/components/AppHeader";
import { ShareToggle } from "@/components/ShareToggle";

export default async function Library() {
  const session = await auth();
  if (!session?.user?.id) {
    // Belt-and-suspenders — proxy.ts already redirects unauthenticated requests here.
    return null;
  }

  const rows = await getDb()
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      targetLength: stories.targetLength,
      isShared: stories.isShared,
      updatedAt: stories.updatedAt,
      paragraphCount: count(storyParagraphs.id),
    })
    .from(stories)
    .leftJoin(storyParagraphs, eq(storyParagraphs.storyId, stories.id))
    .where(eq(stories.ownerId, session.user.id))
    .groupBy(stories.id)
    .orderBy(desc(stories.updatedAt));

  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-6 sm:py-10">
      <div className="w-full max-w-2xl">
        <AppHeader />

        <header className="mb-6 mt-4">
          <h1 className="font-serif text-2xl font-semibold text-foreground">My library</h1>
          <p className="mt-1 text-sm text-muted">Stories you&apos;ve started while signed in.</p>
        </header>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted">
            No saved stories yet.{" "}
            <Link href="/" className="font-medium text-accent">
              Start one
            </Link>{" "}
            to see it here.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((story) => (
              <li
                key={story.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
              >
                <Link href={`/story?storyId=${story.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {story.theme || story.characters || "Untitled story"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {story.paragraphCount} paragraph{story.paragraphCount === 1 ? "" : "s"} · ~
                    {story.targetLength} target · updated{" "}
                    {new Date(story.updatedAt).toLocaleDateString()}
                  </p>
                </Link>
                <ShareToggle storyId={story.id} initialShared={story.isShared} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
