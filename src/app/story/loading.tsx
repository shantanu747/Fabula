/** Shown only for the brief window before story/page.tsx's client bundle
 *  hydrates (it fetches/hydrates its own state client-side after mount, not
 *  through a blocking server data fetch) — shaped like the prose column and
 *  composer it's about to become. */
export default function StoryLoading() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <p role="status" aria-busy="true" className="sr-only">
        Loading your story…
      </p>
      <main className="mx-auto w-full max-w-[800px] px-[22px] pb-[46px] pt-[26px] md:px-6 md:pt-[56px]">
        <div aria-hidden="true" className="flex flex-col gap-6 md:gap-[30px]">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-2.5 w-16 animate-pulse rounded bg-border" />
              <div className="h-3 w-full animate-pulse rounded bg-border" />
              <div className="h-3 w-full animate-pulse rounded bg-border" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-border" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
