# Plan 5 — Security headers and supply-chain automation

**Branch:** `feature/security-headers`
**Depends on:** Plan 2, for the E2E specs that verify headers and catch CSP violations.
**ADR:** required.

## Why this exists

`docs/adr/0011` is a security-hardening pass that closed redirect and enumeration issues, but
`next.config.ts` is still the generated stub — no CSP, no HSTS, no framing protection, no
referrer policy. The app renders user-authored prose from other accounts in `/feed`, which is
precisely the surface a CSP exists for. Nothing scans dependencies, and nothing scans the code.

## What "done" means

- A nonce-based CSP is enforced on every page, verified with zero violations across every route
  including Google sign-in.
- The standard static security headers are set.
- Dependabot, CodeQL, and `npm audit` run automatically.
- A test proves the headers are present, including on redirect responses.

## Read first

`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`. Note that in this
version the middleware file is **`proxy.ts`**, and that the doc sets the CSP on both the
*request* headers (so Next can read the nonce and apply it to its own inline scripts) and the
*response* headers. Both are required; setting only the response header breaks Next's scripts.

## The proxy.ts problem — the hard part of this plan

`src/proxy.ts` today is nine lines: `auth()` wrapping a redirect, with a matcher scoped to
`/library` and `/feed`. CSP needs to run on **every** HTML response, which means widening the
matcher — and the current code redirects anything without a session. Widening the matcher
naively logs everyone out of the homepage.

Restructure so the two concerns are separate and composed in a readable order:

```ts
export default function proxy(request: NextRequest) {
  // 1. mint nonce, build CSP
  // 2. for protected paths only, delegate to the auth handler; if it returns a
  //    redirect, decorate that response with the security headers and return it
  // 3. otherwise NextResponse.next() with the request+response headers set
}
```

Requirements:

- **Redirect responses must carry the headers too.** A response that skips them is a hole, and
  it's the easiest one to miss because the page you land on has them.
- The matcher must exclude `_next/static`, `_next/image`, `favicon.ico`, and other static
  assets — the standard negative-lookahead matcher from the Next docs. Do not run the proxy on
  API routes; they return JSON or a stream and gain nothing from a page CSP.
- The auth-redirect behaviour for `/library` and `/feed` must be **byte-identical** to today,
  including the `callbackUrl` query param. `e2e/specs/auth-gates.spec.ts` from Plan 2 is the
  proof; run it before and after.
- Nonce generation must use `crypto.randomUUID()` per request. A cached or static nonce is
  worse than no CSP.
- Pages using a nonce must render dynamically. Confirm no route silently becomes static and
  serves a stale nonce — if one does, the CSP will block its own scripts intermittently, which
  is a miserable bug to chase.

Extract the CSP string construction into `src/lib/security/csp.ts` as a pure
`buildCsp({ nonce, isDev, reportOnly }): string`. `proxy.ts` itself is awkward to unit test;
the string builder is not, and the directive list is the part worth locking down with a test.

## The policy

Start from the doc's example and adjust for what this app actually loads:

```
default-src 'self';
script-src 'self' 'nonce-{nonce}' 'strict-dynamic'{dev: ' unsafe-eval'};
style-src 'self' 'nonce-{nonce}'{dev: " 'unsafe-inline'"};
img-src 'self' blob: data: https://lh3.googleusercontent.com;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self' https://accounts.google.com;
frame-ancestors 'none';
upgrade-insecure-requests;
```

Three of these need verification rather than trust:

- **`img-src`** — Google account avatars come from `lh3.googleusercontent.com` and land in
  `users.image`. Check whether `AppHeader` renders them directly or through `next/image`; adjust
  the directive to match what the browser actually requests.
- **`form-action`** — the Google sign-in flow POSTs off-origin. `'self'` alone may break it.
  Test it against a real Google client before enforcing, and if the flow turns out to be a
  redirect rather than a form POST, tighten back to `'self'` and say so in a comment.
- **`style-src`** — Tailwind v4 through Next injects styles differently in dev and production.
  Verify against a real `next build && next start`, not just `next dev`; a dev-only allowance is
  fine, a production one is a hole.

## Ship report-only first, then enforce — in this same PR

1. Implement with `Content-Security-Policy-Report-Only`, gated on
   `process.env.CSP_REPORT_ONLY === "true"`.
2. Walk every route with the browser console open: `/`, `/story` (mid-generation, so the
   streaming path is live), `/login`, `/signup`, `/library`, `/feed`, `/feed/[id]`, the error
   and not-found pages, and both sign-in methods.
3. Fix every violation.
4. Flip the default to enforcing, keep the env flag as an escape hatch, and record in the PR
   which routes you walked.

Shipping straight to enforcing and finding out in production is the failure mode this avoids.

## Static headers — `next.config.ts`

CSP belongs in the proxy because of the nonce. Everything else is static and belongs in
`headers()`:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

Also set `poweredByHeader: false`.

`X-Frame-Options` duplicates `frame-ancestors 'none'` — keep both, and comment that the former
is for browsers/proxies that ignore the latter. HSTS does nothing over plain HTTP; setting it
now means it is correct the moment v4 puts a domain in front. Note that in the ADR so a future
reader doesn't think it was cargo-culted.

## Supply chain

**`.github/dependabot.yml`** — two ecosystems:

- `npm`, weekly, grouped: one PR for all patch+minor dev dependencies, one for all patch+minor
  production dependencies, and separate PRs for majors. Ungrouped Dependabot on a repo this size
  produces noise nobody reads.
- `github-actions`, weekly.

Set `open-pull-requests-limit` to something small (5) and add a comment saying why grouping was
chosen — this is the kind of config that reads as thoughtless when it isn't explained.

**`.github/workflows/codeql.yml`** — `github/codeql-action` for
`javascript-typescript`, on `push` to `main`, on `pull_request`, and weekly `schedule`. Default
query suite. Use `security-extended` only if the default is clean and fast; note the choice.

**`npm audit` in `ci.yml`** — add after `npm ci`:

```yaml
      # Fails on high/critical only. Moderate advisories in the transitive dev tree
      # are common enough that failing on them trains everyone to ignore this step.
      - run: npm audit --audit-level=high
```

Decide and write down the policy for a finding with no fix available: `npm audit` has no clean
per-advisory ignore mechanism, so if this blocks you, the answer is a documented, dated
exception in the ADR, not deleting the step.

**Optional but worth it:** pin GitHub Actions to commit SHAs rather than tags
(`actions/checkout@v4` → `actions/checkout@<sha> # v4.x.x`). A tag is mutable; a SHA is not.
Dependabot's `github-actions` ecosystem updates SHA pins automatically, so the maintenance cost
is zero once configured. Do this if it doesn't sprawl the diff.

## Tests

- `src/lib/security/csp.test.ts` — every required directive present; the nonce is interpolated
  into both `script-src` and `style-src`; dev-only allowances appear only when `isDev`; the
  output has no double spaces or trailing semicolon issues; two calls produce different nonces.
- E2E (`e2e/specs/security-headers.spec.ts`, new): assert every static header on `/`; assert a
  `Content-Security-Policy` header with a `nonce-` value on an HTML response; assert the headers
  are present on the `/library` → `/login` **redirect** response (use
  `page.waitForResponse` or a `request.get` with redirects disabled); and register a
  `securitypolicyviolation` listener on each route, asserting zero violations. That last one is
  what stops a future change from quietly breaking the policy.
- Re-run `e2e/specs/auth-gates.spec.ts` unchanged — the proxy restructure must not alter it.

## Gotchas

- `src/proxy.ts` runs on the Edge runtime. `crypto.randomUUID()` is available; `node:crypto` is
  not.
- Widening the matcher means the proxy runs on far more requests. Keep it cheap — no database
  calls, no `auth()` invocation on unprotected paths.
- Auth.js's `auth()` wrapper expects to *be* the default export. Calling it as a nested handler
  works but check the v5 beta's actual signature in `node_modules/next-auth` before assuming;
  if composition proves awkward, calling `auth()` only inside the protected-path branch is the
  simpler shape.
- A CSP applies to the page, not to `/api/generate`'s streamed `text/plain`. Don't try to make
  the streaming response satisfy a page policy.
- `connect-src 'self'` must permit the `/api/generate` fetch. It does — same origin — but if
  Plan 3's OTLP endpoint is ever called from the browser it would not. It isn't; keep it that
  way.
- If Plan 3 is already merged, its `x-request-id` response header must survive the proxy
  restructure. Check.

## Out of scope

- CSP violation *reporting* endpoints (`report-uri`/`report-to`) and their storage. Worth doing
  once there's a deployment; not now.
- Subresource integrity, certificate pinning, or WAF rules.
- Secret scanning beyond what GitHub enables by default.
- Auth or session hardening — ADR 0011 covered that pass.

## ADR

`docs/adr/00NN-security-headers-and-supply-chain.md`. Cover:

- Why CSP lives in `proxy.ts` (nonce per request) while the rest live in `next.config.ts`, and
  how the auth redirect and the header logic were kept from entangling.
- The report-only-then-enforce sequence and which routes were actually walked.
- Each directive that had to be loosened from the strict default, and exactly why — this is the
  section a future reader will need most.
- Why `npm audit` fails at high and not moderate.
- Why HSTS is set before there is a domain.
- Any dated exception for an unfixable advisory.
