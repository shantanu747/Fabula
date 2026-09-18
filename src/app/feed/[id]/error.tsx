"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/reportClientError";

/** Nearer than feed/error.tsx, so it — not the parent — handles a failure
 *  loading this specific shared story (Next always resolves to the closest
 *  error.tsx up the tree). Same header caveat as feed/error.tsx: AppHeader is
 *  this page's own direct child (the print stylesheet needs it there), so it
 *  disappears along with everything else on a throw here. */
export default function SharedStoryError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[shared story error boundary]", error);
    reportClientError(error.digest, typeof window !== "undefined" ? window.location.pathname : "");
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
          Couldn&apos;t load this story
        </h1>
        <p className="mt-3 text-[14px] leading-[1.7] text-muted">
          Something went wrong loading it. This is usually temporary — trying again often works.
        </p>
        {error.digest && (
          <p className="mt-2 text-[12px] tabular-nums text-muted">Reference: {error.digest}</p>
        )}
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <button type="button" onClick={() => retry()} className="btn btn-primary btn-compact">
            Try again
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/feed" className="btn btn-secondary btn-compact">
            Back to the feed
          </a>
        </div>
      </div>
    </div>
  );
}
