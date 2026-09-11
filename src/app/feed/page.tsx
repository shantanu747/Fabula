"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";

interface FeedStory {
  id: string;
  theme: string | null;
  characters: string | null;
  authorName: string | null;
  paragraphCount: number;
  updatedAt: string;
}

export default function Feed() {
  const [stories, setStories] = useState<FeedStory[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  // Starts true so the initial-mount fetch doesn't need to set it synchronously
  // from inside the effect (react-hooks/set-state-in-effect flags that).
  const [isLoading, setIsLoading] = useState(true);

  function fetchPage(offset: number) {
    fetch(`/api/feed?offset=${offset}`)
      .then((res) => res.json())
      .then((data: { stories: FeedStory[]; nextOffset: number | null }) => {
        setStories((prev) => [...prev, ...data.stories]);
        setNextOffset(data.nextOffset);
      })
      .finally(() => setIsLoading(false));
  }

  function loadMore() {
    if (nextOffset === null || isLoading) return;
    setIsLoading(true);
    fetchPage(nextOffset);
  }

  useEffect(() => {
    fetchPage(0);
  }, []);

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

          {stories.length === 0 && !isLoading ? (
            <p className="py-10 text-center text-[13.5px] italic text-muted">No shared stories yet.</p>
          ) : (
            <ul className="flex flex-col">
              {stories.map((story) => (
                <li key={story.id} className="border-b border-border">
                  <Link href={`/feed/${story.id}`} className="group block py-4">
                    <p className="truncate font-heading text-[21px] font-semibold leading-[1.2] text-foreground transition-colors group-hover:text-accent-text">
                      {story.theme || story.characters || "Untitled story"}
                    </p>
                    <p className="mt-1 text-[12.5px] text-muted">
                      by {story.authorName ?? "a Writer"} · {story.paragraphCount} paragraph
                      {story.paragraphCount === 1 ? "" : "s"} · updated{" "}
                      {new Date(story.updatedAt).toLocaleDateString()}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {nextOffset !== null && (
            <div className="mt-8 pb-12">
              <button
                type="button"
                onClick={loadMore}
                disabled={isLoading}
                className="btn btn-secondary btn-block"
              >
                {isLoading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
