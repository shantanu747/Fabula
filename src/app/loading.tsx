/**
 * Shown while a route segment's server work is in flight — the library and feed
 * both query Postgres before they can render. Without a fallback, navigation
 * appears to hang: the browser stays on the previous page with no indication
 * that anything is happening.
 *
 * A Server Component by default, so it costs no client JavaScript.
 */
export default function Loading() {
  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-10 sm:py-14">
      <div className="w-full max-w-2xl">
        {/* aria-busy carries the state; the skeleton itself is decoration and is
            hidden so a screen reader hears the label rather than empty boxes. */}
        <p role="status" aria-busy="true" className="sr-only">
          Loading…
        </p>
        {/* Hairline rows, like the lists they stand in for — no filled cards. */}
        <div aria-hidden="true" className="flex flex-col">
          <div className="mb-6 h-6 w-40 animate-pulse rounded bg-border" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-border py-5">
              <div className="mb-3 h-3 w-20 animate-pulse rounded bg-border" />
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
