import Link from "next/link";

/**
 * Reached by a mistyped URL, and by a shared story that has since been
 * unshared or deleted — the feed hands out links that can outlive their story.
 */
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-serif text-xl font-semibold text-foreground">
          There&apos;s no story here
        </h1>
        <p className="mt-3 text-sm text-muted">
          The page you were looking for doesn&apos;t exist, or the story behind it is no longer
          shared.
        </p>
        <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            Start a new story
          </Link>
          <Link
            href="/feed"
            className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
          >
            Browse the feed
          </Link>
        </div>
      </div>
    </div>
  );
}
