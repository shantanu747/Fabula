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
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-6 sm:py-10">
      <div className="w-full max-w-2xl">
        <AppHeader />

        <header className="mb-6 mt-4">
          <h1 className="font-serif text-2xl font-semibold text-foreground">Shared stories</h1>
          <p className="mt-1 text-sm text-muted">Stories other Writers have chosen to share.</p>
        </header>

        <div className="mb-6 rounded-2xl border border-border bg-ai-soft p-4 text-xs text-muted">
          Shared stories include unmoderated human-written text. If you see something
          that shouldn&apos;t be here, use the Report button on that story.
        </div>

        {stories.length === 0 && !isLoading ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted">
            No shared stories yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {stories.map((story) => (
              <li key={story.id}>
                <Link
                  href={`/feed/${story.id}`}
                  className="block rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-accent"
                >
                  <p className="truncate text-sm font-medium text-foreground">
                    {story.theme || story.characters || "Untitled story"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
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
          <button
            type="button"
            onClick={loadMore}
            disabled={isLoading}
            className="mt-6 w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent disabled:opacity-40"
          >
            {isLoading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
