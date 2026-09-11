"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";

/**
 * Catches anything that throws while rendering a route segment. Without this
 * file a server-side failure — a database that is down, a story row that will
 * not load — leaves the Writer on Next's default error screen with no way back
 * to their story.
 *
 * `retry` re-runs the segment, which is the right affordance for the failures
 * most likely to land here: they are transient. Next 16.3 stabilised this prop;
 * the older `reset` only clears the boundary without re-fetching.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[error boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
          Something went wrong
        </h1>
        <p className="mt-3 text-[14px] leading-[1.7] text-muted">
          The page didn&apos;t load. This is usually temporary — trying again often works.
        </p>
        {/* The only stable handle on a server-side error, since the message
            itself is withheld in production to avoid leaking internals. */}
        {error.digest && (
          <p className="mt-2 text-[12px] tabular-nums text-muted">Reference: {error.digest}</p>
        )}
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <button type="button" onClick={() => retry()} className="btn btn-primary btn-compact">
            Try again
          </button>
          {/*
            A plain anchor, deliberately, rather than next/link: this is the
            escape hatch from a render that already failed, and a client-side
            navigation would carry the same router and StoryContext state into
            the new page. A full document load is the only option here that
            guarantees a clean slate.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="btn btn-secondary btn-compact">
            Start a new story
          </a>
        </div>
      </div>
    </div>
  );
}
