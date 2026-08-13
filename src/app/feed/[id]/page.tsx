import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs, users } from "@/lib/db/schema";
import { AppHeader } from "@/components/AppHeader";
import { ReportButton } from "@/components/ReportButton";

export default async function SharedStory({ params }: PageProps<"/feed/[id]">) {
  const { id } = await params;

  const db = getDb();
  const [row] = await db
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      isShared: stories.isShared,
      authorName: users.name,
    })
    .from(stories)
    .innerJoin(users, eq(users.id, stories.ownerId))
    .where(eq(stories.id, id));

  if (!row || !row.isShared) notFound();

  const paragraphs = await db
    .select({
      author: storyParagraphs.authorType,
      text: storyParagraphs.text,
    })
    .from(storyParagraphs)
    .where(eq(storyParagraphs.storyId, id))
    .orderBy(asc(storyParagraphs.position));

  const headerParts = [row.theme, row.characters].filter((p): p is string => Boolean(p));

  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-10 sm:py-14">
      <div className="w-full max-w-2xl">
        <AppHeader />

        <header className="mb-6 mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              Shared by {row.authorName ?? "a Writer"}
            </p>
            {headerParts.length > 0 && (
              <p className="mt-1 text-xs text-muted">🏮 {headerParts.join(" · ")}</p>
            )}
          </div>
          <ReportButton storyId={row.id} />
        </header>

        <div className="flex flex-col gap-4">
          {paragraphs.map((p, i) => (
            <article
              key={i}
              className={
                p.author === "ai"
                  ? "rounded-2xl border border-border bg-ai-soft p-5"
                  : "rounded-2xl border border-border bg-card p-5"
              }
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={
                    p.author === "ai"
                      ? "inline-flex items-center rounded-full bg-ai px-2.5 py-0.5 text-xs font-medium text-accent-foreground"
                      : "inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground"
                  }
                >
                  {p.author === "ai" ? "AI" : row.authorName ?? "Writer"}
                </span>
              </div>
              <p className="font-serif text-[15px] leading-7 text-foreground">{p.text}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
