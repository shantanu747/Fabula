"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";

/** AppHeader is hoisted to library/layout.tsx, outside this boundary — a
 *  failure loading the library replaces this content but leaves the header
 *  (and its sign-out/nav links) usable, unlike feed/[id]'s. */
export default function LibraryError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[library error boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
          Couldn&apos;t load your library
        </h1>
        <p className="mt-3 text-[14px] leading-[1.7] text-muted">
          Something went wrong loading your saved stories. This is usually temporary — trying again
          often works.
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
