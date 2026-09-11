import Link from "next/link";
import { ShareToggle } from "@/components/ShareToggle";

export interface LibraryRowData {
  id: string;
  theme: string | null;
  characters: string | null;
  targetLength: number;
  isShared: boolean;
  updatedAt: Date;
  paragraphCount: number;
}

/**
 * Plain presentational component — no "use client" of its own — so it renders
 * identically from the server-rendered first page (library/page.tsx) and from
 * the client "load more" island (LibraryLoadMore.tsx) without duplicating this
 * markup between them.
 */
export function LibraryStoryRow({ story }: { story: LibraryRowData }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
      <Link href={`/story?storyId=${story.id}`} className="group min-w-0 flex-1">
        <p className="truncate font-heading text-[21px] font-semibold leading-[1.2] text-foreground transition-colors group-hover:text-accent-text">
          {story.theme || story.characters || "Untitled story"}
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          {story.paragraphCount} paragraph{story.paragraphCount === 1 ? "" : "s"} · ~
          {story.targetLength} target · updated{" "}
          {story.updatedAt.toLocaleDateString()}
        </p>
      </Link>
      <ShareToggle storyId={story.id} initialShared={story.isShared} />
    </li>
  );
}
