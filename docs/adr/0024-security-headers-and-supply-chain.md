# 24. Security headers and supply-chain automation

## Status

Accepted.

## Context

`docs/adr/0011-security-hardening-post-review.md` closed a redirect-phishing vector and a
registration-enumeration oracle, but `next.config.ts` was still the generated stub: no CSP, no
HSTS, no framing protection, no referrer policy. `/feed` and `/feed/[id]` render other Writers'
unmoderated prose (`docs/adr/0010`), which is exactly the surface a CSP exists for. Nothing
scanned dependencies or code for known vulnerabilities.

## Decision

### Why CSP lives in `proxy.ts`, not `next.config.ts`

A CSP nonce must be fresh per request (`crypto.randomUUID()`), and `next.config.ts`'s
`headers()` has no access to a request — it runs once, at build/route-manifest time, and
produces a static header value. `proxy.ts` runs per request and can mint one. Everything that
doesn't need a nonce (HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`) stays in `next.config.ts`'s `headers()`,
matched against every route (`source: "/(.*)"`) including API routes and static assets — there's
no reason a JSON response or a font file shouldn't also get `nosniff`/HSTS/frame-denial, and
matching everything is simpler than carving out exceptions for headers that have none.

### Keeping the auth redirect and the CSP from entangling

`src/proxy.ts` previously wrapped Auth.js's `auth(handler)` overload directly — the whole file
existed only to redirect `/library` and `/feed` to `/login` when signed out, on a matcher scoped
to exactly those two path prefixes. Widening the matcher to run on every page (so the CSP
applies everywhere) meant that overload no longer fit: `auth(handler)` designates the *entire*
proxy as the auth check, with no room to also unconditionally compute a nonce and attach headers
to every response, redirects included.

The restructure separates the two concerns instead of layering one on the other:

1. Compute the nonce and CSP string unconditionally, once per request.
2. If the path is `/library` or `/feed` (an exact match or a `/`-prefixed subpath), call `await
   auth()` — the zero-argument session-read overload used at every other call site in the app
   (`src/app/layout.tsx`, every route handler) — and redirect to `/login?callbackUrl=...` if
   there's no session. The redirect response is decorated with the same security headers before
   it returns.
3. Otherwise (or once the session check passes), attach the nonce to the request headers (so
   Next's renderer can read it back out and apply it to framework/page scripts, per
   `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) and to the
   response, and continue.

The old file's comment explained that `auth(handler)` — the middleware-wrapping overload — is
the one affected by `src/auth.ts`'s lazy config factory (it resolves to a `Promise` of the
handler rather than the handler itself under that form), and that the zero-argument `await
auth()` form doesn't have this quirk. That comment turned out to point at the simpler shape
directly: calling `await auth()` only inside the protected-path branch removes the
promise-of-a-handler indirection entirely, and next-auth's own types document the zero-arg form
as valid in Middleware, Server Components, Route Handlers, and API routes alike — not just the
latter three. Verified against `e2e/specs/auth-gates.spec.ts`, unchanged, both before and after
the restructure: identical redirect target, identical `callbackUrl` encoding
(`/login?callbackUrl=%2Flibrary`), identical guest-access behavior for `/` and `/story`.

The matcher itself is the Next docs' standard catch-all
(`/((?!api|_next/static|_next/image|favicon.ico).*)`, with the `missing` clause that excludes
`next-router-prefetch`/`purpose: prefetch` requests) — API routes are excluded because they
return JSON or a stream and gain nothing from a page CSP (`/api/generate`'s streamed
`text/plain` in particular was never a candidate; a CSP applies to the page that reads the
stream, not the stream itself).

### The policy, and what had to be verified rather than assumed

```
default-src 'self';
script-src 'self' 'nonce-{nonce}' 'strict-dynamic'{dev: " 'unsafe-eval'"};
style-src 'self' 'nonce-{nonce}'{dev: " 'unsafe-inline'"};
img-src 'self' blob: data:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
```

Three directives the plan flagged as needing verification, not assumption:

- **`img-src`** doesn't allow `lh3.googleusercontent.com`. `AppHeader.tsx` — the only place a
  signed-in Writer's identity renders — shows `session.user?.name ?? session.user?.email` as
  plain text and never renders `session.user.image` anywhere in the app. There is currently no
  `<img>` pointed at a Google avatar to allow.
- **`form-action 'self'`** doesn't allow `https://accounts.google.com`, and this was checked
  against next-auth's actual client code rather than clicked through a live OAuth consent
  screen (no `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are configured in CI or this dev
  environment — a real end-to-end Google sign-in remains the named gap `docs/adr/0019` already
  records). `node_modules/next-auth/react.js`'s `signIn()` does a same-origin `fetch()` POST to
  `/api/auth/signin/google` — governed by `connect-src`, which is already `'self'` — and only
  after that resolves does it run `window.location.href = data.url`, a plain top-level
  navigation to Google. Neither step is a `<form>` submission, so `form-action` never enters the
  picture; the plan's own fallback ("if the flow turns out to be a redirect rather than a form
  POST, tighten back to `'self'`") is what applies here.
- **`style-src`** has no `'unsafe-inline'` in production. Verified by running `next build && next
  start` and inspecting response headers directly (`curl -sD -`): the production CSP on `/`
  contains `style-src 'self' 'nonce-{nonce}'` with no `'unsafe-inline'`, and the page's inline
  `<style>`/`<link rel=preload as=style>` tags Next emits both carry the same nonce. Tailwind
  v4's production output ships as a linked stylesheet, not inline styles, so the dev-only
  allowance (Next's Fast Refresh injects style tags without the request's nonce attached) isn't
  needed there.

`src/lib/security/csp.ts`'s `buildCsp({ nonce, isDev })` deliberately has no `reportOnly`
parameter, unlike the plan's literal sketch: report-only vs. enforcing only changes which
response header name carries the string (`Content-Security-Policy` vs.
`Content-Security-Policy-Report-Only`), decided in `proxy.ts` from `CSP_REPORT_ONLY`, and never
changes the policy's content. A parameter that can't affect its function's output is dead code.

### Dynamic rendering

Nonce-based CSP requires every page to render dynamically — a statically-generated page bakes in
whatever nonce happened to exist at build time, and every real request after that gets a CSP
that doesn't match what's actually in the HTML. This repo already has that property incidentally:
`src/app/layout.tsx` is an `async` Server Component that calls `await auth()` at the root, which
reads cookies and forces the entire tree dynamic (there is no Partial Prerendering here, so one
dynamic API anywhere in the render forces the whole request dynamic — there's no static shell to
fall back to). Confirmed directly from `next build`'s route table: every route, including
`/_not-found`, is marked `ƒ (Dynamic)`, with none marked `○ (Static)`. This was true before this
change and remains true after it; the CSP work didn't have to force it, only rely on it, and the
build output is the thing to re-check if a future change ever removes that root-layout `auth()`
call.

### Report-only, then enforce

Implemented behind `CSP_REPORT_ONLY` (default unset → enforcing), walked every route with a
`securitypolicyviolation` listener attached (`e2e/specs/security-headers.spec.ts`, using the
same mechanism the plan's manual-walk step described, automated instead of eyeballed) covering:
`/`, `/login`, `/signup`, `/story` empty, `/story` mid-generation (a delayed mock stream, checked
before the paragraph settles), `/story` in its generation-error state, a 404, `/library`,
`/feed`, and `/feed/[id]`. Zero violations on any of them. The global `app/error.tsx` boundary
(distinct from `/story`'s own inline error banner) was not separately exercised — nothing in the
existing e2e suite triggers it today (it requires simulating a server-side failure, e.g. a
downed database), and building that scaffolding is out of scope for this pass. Clicking
"Continue with Google" itself is also not exercised end-to-end, for the same unconfigured-client
reason `form-action` above was verified by reading source instead of clicking through — the
button's presence and markup are covered by the `/login` walk, which had zero violations.

### Static headers

`X-Frame-Options: DENY` is kept alongside `frame-ancestors 'none'` even though the CSP directive
supersedes it in any browser that honors CSP — for a browser or intermediary proxy that doesn't,
the header is the only protection. `Strict-Transport-Security` is set even though this app is
served over plain HTTP in every environment that exists today (local dev, CI, this review) and
HSTS has no effect until a real HTTPS deployment exists to enforce it against — it's set now so
it's already correct the moment v4 puts a domain in front, rather than something to remember to
add later.

### Supply chain

`npm audit --audit-level=high` runs after `npm ci` in the `build` job. High/critical only:
`npm audit` has no per-advisory ignore mechanism, and moderate findings in a transitive dev-only
tree are common enough that failing CI on them trains everyone to ignore the step. At the time
of this change, `npm audit` reports 4 moderate findings, all the same root cause — `drizzle-kit`
pulls an `esbuild` version vulnerable to a dev-server request-forgery advisory
(`GHSA-67mh-4wv8-2f99`) via `@esbuild-kit/core-utils`. This is a `devDependency`'s dev-server
issue, not something that ships to production, and the only fix available
(`npm audit fix --force`) downgrades `drizzle-kit` to `0.18.1` — a breaking change not worth
taking for a moderate, dev-only advisory. No high/critical finding exists as of this ADR, so no
dated exception was needed; if `npm audit --audit-level=high` ever blocks CI on a finding with no
available fix, the resolution is a new dated entry in this file (or a superseding ADR), not
deleting the step.

Dependabot (`.github/dependabot.yml`) runs weekly on two ecosystems. `npm` updates are grouped —
one PR for all patch/minor dev-dependency bumps, one for all patch/minor production-dependency
bumps — because ungrouped Dependabot on this dependency count is noise nobody reads; majors are
intentionally left ungrouped (one PR each) since those are the ones actually worth reviewing
individually. `github-actions` updates are their own ecosystem, ungrouped (there are few enough
that grouping buys nothing). `open-pull-requests-limit: 5` on both.

CodeQL (`.github/workflows/codeql.yml`) runs the default `javascript-typescript` query suite on
push to `main`, on every PR, and weekly. The default suite was chosen over `security-extended`
without a local benchmark — the CodeQL CLI isn't available in this dev environment to compare the
two directly, so this starts from GitHub's documented default rather than a measurement. Revisit
once a real run on `main` shows whether the default is fast/clean enough, or if
`security-extended` can be compared against it directly.

GitHub Actions are pinned to commit SHAs (`actions/checkout`, `actions/setup-node`,
`actions/cache`, `actions/upload-artifact`, `github/codeql-action`), with the version in a
trailing comment, rather than left on floating major tags (`@v4`). A tag is mutable — a
compromised or careless maintainer can repoint one — a SHA is not. Dependabot's `github-actions`
ecosystem updates SHA pins automatically (it tracks the pinned SHA back to its tag and opens a PR
when a new one is released), so this costs nothing to maintain going forward. The diff this added
was four lines in `ci.yml` and three in the new `codeql.yml`, well short of "sprawling."

## Consequences

- `src/proxy.ts` now does strictly more per request (nonce generation, header construction) on
  every page instead of only on two path prefixes. No database call or `auth()` invocation
  happens outside the `/library`/`/feed` branch, so the added cost is a UUID and a template
  string — measured as negligible against the `next build && next start` baseline used to verify
  this change, but worth remembering if a future addition to `proxy.ts` is tempted to do
  anything heavier on the common path.
- `CSP_REPORT_ONLY=true` is a real, if narrow, escape hatch: it exists to let a future production
  incident be diagnosed (switch to report-only, observe, fix, switch back) without redeploying
  the policy string itself. It is not a development convenience — normal local dev runs enforcing,
  same as production will.
- While verifying this change's e2e coverage, an apparently pre-existing, unrelated flake was
  observed in `e2e/specs/guest-adoption.spec.ts` (roughly 1-in-15 to 1-in-30 across repeated
  runs, with different failure symptoms — a sign-in timeout once, a paragraph-count mismatch
  another time). It reproduces identically on `main` with none of this change's commits applied,
  so it is not something this PR introduced or is fixing; it's recorded here only so a future
  reader doesn't mistake a CI flake on that spec for a regression from the security-headers work.
  It joins `docs/adr/0020` and `docs/adr/0021` as a known-flaky-spec data point, not yet
  diagnosed to the standard those records hold themselves to.
- Anything added to the app that renders off-origin content (an avatar image, a third-party
  embed, an analytics script) will need a corresponding `img-src`/`script-src`/`connect-src`
  addition, and per this ADR's `img-src` note, will need one immediately if avatar rendering is
  ever added to `AppHeader.tsx`.
