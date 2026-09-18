/**
 * Buckets a client-reported pathname into one of this app's own known page
 * templates, the same cardinality discipline `withRoute.ts` applies on the
 * server (docs/adr/0049) — except here the caller is `/api/telemetry`, a
 * public, unauthenticated endpoint, and the "route" comes from the request
 * body, not a literal the server itself chose. Trusting it verbatim as a
 * metric attribute would let anyone mint unbounded time series just by
 * POSTing distinct strings; anything that isn't one of this app's actual
 * page routes collapses to `"other"`.
 *
 * Mirrors `docs/architecture.md`'s directory layout's page list exactly —
 * update both together if a page route is added or removed.
 */
const KNOWN_ROUTES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/$/, label: "/" },
  { pattern: /^\/story\/?$/, label: "/story" },
  { pattern: /^\/library\/?$/, label: "/library" },
  { pattern: /^\/feed\/?$/, label: "/feed" },
  { pattern: /^\/feed\/[^/]+\/?$/, label: "/feed/[id]" },
  { pattern: /^\/login\/?$/, label: "/login" },
  { pattern: /^\/signup\/?$/, label: "/signup" },
  { pattern: /^\/forgot\/?$/, label: "/forgot" },
  { pattern: /^\/reset\/?$/, label: "/reset" },
  { pattern: /^\/verify\/?$/, label: "/verify" },
];

export function normalizeClientRoute(route: unknown): string {
  if (typeof route !== "string" || route.length === 0 || route.length > 200) return "other";
  const match = KNOWN_ROUTES.find(({ pattern }) => pattern.test(route));
  return match?.label ?? "other";
}
