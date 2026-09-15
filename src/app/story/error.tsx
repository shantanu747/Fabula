"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";

/**
 * `StoryContext` lives in `src/app/providers.tsx`, mounted by the root
 * layout — an ancestor of this boundary, not a descendant of it. A render
 * throw inside `story/page.tsx` unmounts only this segment, not the
 * provider tree above it, so the Writer's paragraphs are still sitting in
 * `StoryContext`'s state when `retry()` re-renders the segment against it.
 * The copy below says so plainly, since that's the one thing a Writer mid-
 * story most needs to know before deciding whether to leave.
 *
 * AppHeader stays inline in story/page.tsx rather than hoisted to a
 * layout.tsx here — its `variant="canvas"` render depends on live
 * `useStory()` state (theme, paragraph count, Share/Save actions), so it
 * can't be split out into a server-rendered layout the way feed's list view
 * and library's header were. A crash here does take the header down with it.
 */
export default function StoryError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[story error boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
          Something went wrong
        </h1>
        <p className="mt-3 text-[14px] leading-[1.7] text-muted">
          The page hit a display problem — your writing is still here. Trying again usually
          brings it right back.
        </p>
        {error.digest && (
          <p className="mt-2 text-[12px] tabular-nums text-muted">Reference: {error.digest}</p>
        )}
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <button type="button" onClick={() => retry()} className="btn btn-primary btn-compact">
            Try again
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="btn btn-secondary btn-compact">
            Start a new story
          </a>
        </div>
      </div>
    </div>
  );
}
