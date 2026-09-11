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
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <div className="flex w-full flex-col items-center px-4 sm:px-6">
        <div className="w-full max-w-2xl">
          <header className="mt-10">
            <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
              My library
            </h1>
            <p className="mt-2 text-[13.5px] text-muted">Stories you&apos;ve started while signed in.</p>
          </header>

          {rows.length === 0 ? (
            <p className="mt-6 border-t border-border py-10 text-center text-[13.5px] italic text-muted">
              No saved stories yet.{" "}
              <Link
                href="/"
                className="not-italic text-accent-text underline decoration-accent/50 underline-offset-2"
              >
                Start one
              </Link>{" "}
              to see it here.
            </p>
          ) : (
            <ul className="mt-6 flex flex-col border-t border-border pb-12">
              {rows.map((story) => (
                <li
                  key={story.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4"
                >
                  <Link href={`/story?storyId=${story.id}`} className="group min-w-0 flex-1">
                    <p className="truncate font-heading text-[21px] font-semibold leading-[1.2] text-foreground transition-colors group-hover:text-accent-text">
                      {story.theme || story.characters || "Untitled story"}
                    </p>
                    <p className="mt-1 text-[12.5px] text-muted">
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
    </div>
  );
}
