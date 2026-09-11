import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { getCachedFeedPage0 } from "@/lib/db/feedCache";
import { AppHeader } from "@/components/AppHeader";
import { FeedStoryRow } from "@/components/FeedStoryRow";
import { FeedLoadMore } from "@/components/FeedLoadMore";

// Explicit, not just implied by auth()'s use of cookies(): this page's
// content is per-request (a Writer's own session plus whatever's currently
// shared), so it should never be a candidate for static generation or the
// server-side Full Route Cache, regardless of how those defaults evolve.
export const dynamic = "force-dynamic";

export default async function Feed() {
  const session = await auth();
  if (!session?.user?.id) {
    // Belt-and-suspenders — proxy.ts already redirects unauthenticated requests here.
    return null;
  }

  const { rows, nextCursor } = await getCachedFeedPage0(getDb());

  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <div className="flex w-full flex-col items-center px-4 sm:px-6">
        <div className="w-full max-w-2xl">
          <header className="mt-10">
            <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
              Shared stories
            </h1>
            <p className="mt-2 text-[13.5px] text-muted">Stories other Writers have chosen to share.</p>
          </header>

          <p className="mt-6 border-y border-border py-3 text-[12.5px] italic leading-[1.7] text-muted">
            Shared stories include unmoderated human-written text. If you see something
            that shouldn&apos;t be here, use the Report button on that story.
          </p>

          {rows.length === 0 ? (
            <p className="py-10 text-center text-[13.5px] italic text-muted">No shared stories yet.</p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((story) => (
                <FeedStoryRow key={story.id} story={story} />
              ))}
            </ul>
          )}

          <FeedLoadMore initialNextCursor={nextCursor} />
        </div>
      </div>
    </div>
  );
}
