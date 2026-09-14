/**
 * CSRF guard for the app's own mutating routes (docs/adr/0048). `Content-Type:
 * application/json` was never a real control — it happens to force a CORS
 * preflight today, but that's an accident of body shape, not something this
 * app decided. `POST /api/stories/[id]/report` reads no body at all and is a
 * CORS-*simple* request: no preflight, forgeable cross-site with a bare HTML
 * form. Origin comparison is the actual control, applied uniformly to every
 * mutating route regardless of what its body looks like.
 *
 * Full-origin string equality needs none of `safeCallbackUrl`'s
 * backslash-normalization defense (docs/adr/0011) — that bug was about a
 * *path* being misread as absolute by a browser's URL resolver; there is no
 * equivalent ambiguity comparing two already-resolved origins for exact
 * equality. `new URL(request.url).origin` is this server's own view of what
 * it was reached at (Next resolves it from the same trusted proxy headers
 * every other request-derived value in this app already trusts), so no
 * separate "expected origin" configuration is needed.
 *
 * Absent `Origin` is rejected, not treated as same-origin: browsers omit it
 * on some plain top-level navigations and same-origin requests can still
 * carry it, but a same-origin `fetch()` call — what every mutating route in
 * this app is actually driven by — always sends it, so requiring it costs
 * real clients nothing while closing off a bare `<form>` POST that a browser
 * might otherwise send without one.
 */
export function assertSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return Response.json({ error: "Cross-site request rejected." }, { status: 403 });
  }
  return null;
}
