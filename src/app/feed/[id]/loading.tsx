/** Shown while a single shared story's two queries (docs/adr/0041) are in
 *  flight — shaped like the printed-piece masthead and prose it's about to
 *  become, not the list skeleton feed/loading.tsx uses. */
export default function SharedStoryLoading() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <p role="status" aria-busy="true" className="sr-only">
        Loading this story…
      </p>
      <main className="mx-auto w-full max-w-[820px] px-[22px] pb-14 pt-10 md:px-[92px] md:pt-[54px]">
        <div aria-hidden="true" className="flex flex-col items-center text-center">
          <div className="h-4 w-24 animate-pulse rounded bg-border" />
          <div className="mt-4 h-9 w-3/4 animate-pulse rounded bg-border" />
          <div className="mt-3 h-3 w-56 animate-pulse rounded bg-border" />
        </div>
        <div aria-hidden="true" className="mt-10 flex flex-col gap-[22px]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-full animate-pulse rounded bg-border" />
              <div className="h-3 w-full animate-pulse rounded bg-border" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-border" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
