"use client";

import { useRef, useState } from "react";
import { FeedStoryRow, type FeedRowData } from "@/components/FeedStoryRow";

interface RawFeedRow extends Omit<FeedRowData, "updatedAt"> {
  updatedAt: string;
}

export function FeedLoadMore({ initialNextCursor }: { initialNextCursor: string | null }) {
  const [rows, setRows] = useState<FeedRowData[]>([]);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  // Guards a double click (or a slow response outliving the button's own
  // disabled state) from appending the same page twice — same shape as
  // LibraryLoadMore's guard.
  const mergedCursors = useRef(new Set<string>());

  async function loadMore() {
    if (nextCursor === null || isLoading) return;
    const cursor = nextCursor;
    setIsLoading(true);
    setHasError(false);
    try {
      const response = await fetch(`/api/feed?cursor=${encodeURIComponent(cursor)}`);
      if (!response.ok) {
        setHasError(true);
        return;
      }
      const data: { stories: RawFeedRow[]; nextCursor: string | null } = await response.json();
      if (mergedCursors.current.has(cursor)) return;
      mergedCursors.current.add(cursor);
      setRows((prev) => [...prev, ...data.stories.map((s) => ({ ...s, updatedAt: new Date(s.updatedAt) }))]);
      setNextCursor(data.nextCursor);
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((story) => (
            <FeedStoryRow key={story.id} story={story} />
          ))}
        </ul>
      )}
      {nextCursor !== null && (
        <div className="mt-8 pb-12">
          <button type="button" onClick={loadMore} disabled={isLoading} className="btn btn-secondary btn-block">
            {isLoading ? "Loading…" : hasError ? "Try again" : "Load more"}
          </button>
          {hasError && (
            <p role="alert" className="mt-2 text-center text-[12px] italic text-muted">
              Couldn&apos;t load more stories.
            </p>
          )}
        </div>
      )}
    </>
  );
}
