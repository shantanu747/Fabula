import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { stories, storyParagraphs, users } from "@/lib/db/schema";
import { getProviderList } from "@/lib/providers/list";
import { AppHeader } from "@/components/AppHeader";
import { ReportButton } from "@/components/ReportButton";
import { splitDisplayName } from "@/lib/ui/providerName";
import { numberWord } from "@/lib/ui/numberWord";

// A finished story reads as one printed piece (board 1e): 16.5px / 1.9 Lora,
// justified, 22px apart, no author labels. Attribution moves to the footer.
const PROSE = "font-body text-[16px] leading-[1.85] text-prose md:text-[16.5px] md:leading-[1.9] md:text-justify md:hyphens-auto [text-wrap:pretty]";
// The drop cap on the first paragraph: Cormorant 400 at 62px, in the accent.
const DROP_CAP =
  "first-letter:float-left first-letter:pr-[10px] first-letter:pt-1 first-letter:font-heading first-letter:text-[62px] first-letter:font-normal first-letter:leading-[0.82] first-letter:text-accent";

export default async function SharedStory({ params }: PageProps<"/feed/[id]">) {
  const { id } = await params;

  const db = getDb();
  const [row] = await db
    .select({
      id: stories.id,
      theme: stories.theme,
      characters: stories.characters,
      isShared: stories.isShared,
      selectedProviderId: stories.selectedProviderId,
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

  // Stories have no title field; the theme stands in, then the characters
  // (docs/adr/0033). Both are set in the same 42px Cormorant either way.
  const title = row.theme?.trim() || row.characters?.trim() || "A shared story";
  const authorName = row.authorName ?? "a Writer";
  const provider = getProviderList().find((p) => p.id === row.selectedProviderId);
  const modelName = provider ? splitDisplayName(provider.displayName).name : "an AI";
  const count = paragraphs.length;

  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />

      <main className="mx-auto w-full max-w-[820px] px-[22px] pb-14 pt-10 md:px-[92px] md:pt-[54px]">
        {/* The masthead — the one centered layout in the product. */}
        <header className="text-center">
          <p className="kicker">From the feed</p>
          <h1 className="mt-4 font-heading text-[32px] font-normal leading-[1.15] text-foreground md:text-[42px]">
            {title}
          </h1>
          <p className="mt-3 text-[13px] italic leading-[1.7] text-muted">
            Written by {authorName} with {modelName} · {numberWord(count)} paragraph{count === 1 ? "" : "s"}
          </p>
          <div aria-hidden="true" className="mt-6 flex items-center justify-center gap-3">
            <span className="h-px w-11 bg-border" />
            <span className="block h-[6px] w-[6px] rotate-45 bg-accent" />
            <span className="h-px w-11 bg-border" />
          </div>
        </header>

        <div className="mt-10 flex flex-col gap-[22px]">
          {paragraphs.map((p, i) => (
            <p key={i} className={i === 0 ? `${PROSE} ${DROP_CAP}` : PROSE}>
              {p.text}
            </p>
          ))}
        </div>

        <footer className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-4 border-t border-border pt-6">
          <p className="text-[11.5px] leading-[1.6] text-muted">
            Paragraphs alternate between {authorName} and {modelName}.
          </p>
          <div className="ml-auto flex items-center gap-5">
            <Link href="/" className="btn btn-primary btn-compact">
              Start one like this
            </Link>
            <ReportButton storyId={row.id} />
          </div>
        </footer>
      </main>
    </div>
  );
}
