"use client";

import { useRef, useState } from "react";
import { LibraryStoryRow, type LibraryRowData } from "@/components/LibraryStoryRow";

interface RawLibraryRow extends Omit<LibraryRowData, "updatedAt"> {
  updatedAt: string;
}

export function LibraryLoadMore({ initialNextCursor }: { initialNextCursor: string | null }) {
  const [rows, setRows] = useState<LibraryRowData[]>([]);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [isLoading, setIsLoading] = useState(false);
  // Guards a double click (or a slow response outliving the button's own
  // disabled state) from appending the same page twice.
  const mergedCursors = useRef(new Set<string>());

  async function loadMore() {
    if (nextCursor === null || isLoading) return;
    const cursor = nextCursor;
    setIsLoading(true);
    try {
      const response = await fetch(`/api/stories?cursor=${encodeURIComponent(cursor)}`);
      if (!response.ok) return;
      const data: { stories: RawLibraryRow[]; nextCursor: string | null } = await response.json();
      if (mergedCursors.current.has(cursor)) return;
      mergedCursors.current.add(cursor);
      setRows((prev) => [...prev, ...data.stories.map((s) => ({ ...s, updatedAt: new Date(s.updatedAt) }))]);
      setNextCursor(data.nextCursor);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      {rows.length > 0 && (
        <ul className={nextCursor === null ? "flex flex-col pb-12" : "flex flex-col"}>
          {rows.map((story) => (
            <LibraryStoryRow key={story.id} story={story} />
          ))}
        </ul>
      )}
      {nextCursor !== null && (
        <div className="mt-4 pb-12">
          <button type="button" onClick={loadMore} disabled={isLoading} className="btn btn-secondary btn-block">
            {isLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
