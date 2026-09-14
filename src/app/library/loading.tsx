/** Shown while /library's Postgres query is in flight — same hairline-row
 *  shape as feed/loading.tsx, under the header library/layout.tsx composes
 *  it with. Server Component — no client JS cost. */
export default function LibraryLoading() {
  return (
    <div className="flex w-full flex-col items-center px-4 sm:px-6">
      <div className="w-full max-w-2xl">
        <p role="status" aria-busy="true" className="sr-only">
          Loading your library…
        </p>
        <div aria-hidden="true" className="flex flex-col">
          <div className="mb-6 mt-10 h-8 w-40 animate-pulse rounded bg-border" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-border py-5">
              <div className="mb-3 h-3 w-24 animate-pulse rounded bg-border" />
              <div className="space-y-2">
                <div className="h-3 w-full animate-pulse rounded bg-border" />
                <div className="h-3 w-11/12 animate-pulse rounded bg-border" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-border" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
