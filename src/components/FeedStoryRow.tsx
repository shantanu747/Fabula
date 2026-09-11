import Link from "next/link";

export interface FeedRowData {
  id: string;
  theme: string | null;
  characters: string | null;
  authorName: string | null;
  updatedAt: Date;
  paragraphCount: number;
}

/** Plain presentational component, no "use client" — renders identically from
 *  the server-rendered first page (feed/page.tsx) and the client "load more"
 *  island (FeedLoadMore.tsx). */
export function FeedStoryRow({ story }: { story: FeedRowData }) {
  return (
    <li className="border-b border-border">
      <Link href={`/feed/${story.id}`} className="group block py-4">
        <p className="truncate font-heading text-[21px] font-semibold leading-[1.2] text-foreground transition-colors group-hover:text-accent-text">
          {story.theme || story.characters || "Untitled story"}
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          by {story.authorName ?? "a Writer"} · {story.paragraphCount} paragraph
          {story.paragraphCount === 1 ? "" : "s"} · updated{" "}
          {story.updatedAt.toLocaleDateString()}
        </p>
      </Link>
    </li>
  );
}
