import Link from "next/link";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { getLibraryPage } from "@/lib/db/feedAndLibrary";
import { AppHeader } from "@/components/AppHeader";
import { LibraryStoryRow } from "@/components/LibraryStoryRow";
import { LibraryLoadMore } from "@/components/LibraryLoadMore";

export default async function Library() {
  const session = await auth();
  if (!session?.user?.id) {
    // Belt-and-suspenders — proxy.ts already redirects unauthenticated requests here.
    return null;
  }

  const { rows, nextCursor } = await getLibraryPage(getDb(), session.user.id);

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
            <>
              <ul className={nextCursor === null ? "mt-6 flex flex-col border-t border-border pb-12" : "mt-6 flex flex-col border-t border-border"}>
                {rows.map((story) => (
                  <LibraryStoryRow key={story.id} story={story} />
                ))}
              </ul>
              <LibraryLoadMore initialNextCursor={nextCursor} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
