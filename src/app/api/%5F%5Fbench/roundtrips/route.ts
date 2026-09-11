import { getRoundtripCounter } from "../../../../../bench/roundtrips";

/**
 * Dev-only instrumentation for bench/harness.ts (docs/plans/v4/01-load-harness.md,
 * docs/adr/0034). Returns the DB round-trip counts accumulated since the last call
 * and resets them, so the harness can attribute a clean count to exactly one
 * /api/generate call by calling this immediately before and after it.
 *
 * Gated on BENCH_INSTRUMENTATION, which is never set outside a harness run (see
 * src/lib/db/client.ts) — 404 rather than a body is deliberate: this route must be
 * indistinguishable from one that doesn't exist in a normal build or deployment.
 * See route.test.ts.
 *
 * Lives under `src/app/api/%5F%5Fbench/`, not `__bench/`: App Router treats any
 * folder prefixed with a literal underscore as private and excludes it (and
 * everything under it) from routing entirely, silently — a plain `__bench`
 * directory here builds cleanly but the route never appears in `next build`'s
 * route list and 404s unconditionally. `%5F` is the documented escape hatch
 * (the URL-encoded underscore) for a segment that must start with one on the
 * wire; the URL path is still exactly `/api/__bench/roundtrips`.
 */
export async function GET(): Promise<Response> {
  if (process.env.BENCH_INSTRUMENTATION !== "1") {
    return new Response(null, { status: 404 });
  }
  const counter = getRoundtripCounter();
  const counts = { ...counter.counts, total: counter.total() };
  counter.reset();
  return Response.json(counts);
}
