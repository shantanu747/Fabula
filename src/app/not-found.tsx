import Link from "next/link";

/**
 * Reached by a mistyped URL, and by a shared story that has since been
 * unshared or deleted — the feed hands out links that can outlive their story.
 */
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-[32px] font-normal leading-[1.12] text-foreground">
          There&apos;s no story here
        </h1>
        <p className="mt-3 text-[14px] leading-[1.7] text-muted">
          The page you were looking for doesn&apos;t exist, or the story behind it is no longer
          shared.
        </p>
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <Link href="/" className="btn btn-primary btn-compact">
            Start a new story
          </Link>
          <Link href="/feed" className="btn btn-secondary btn-compact">
            Browse the feed
          </Link>
        </div>
      </div>
    </div>
  );
}
