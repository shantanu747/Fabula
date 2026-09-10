# 27. CI quality gates: responsive, accessibility, bundle budget, typecheck

## Status

Accepted.

## Context

Three checks the repo already believed in were not actually enforced. `AGENTS.md` makes
responsive layout a hard requirement and `scripts/responsive-check.mjs` existed to verify it, but
nothing in CI ran it — it only ran if someone remembered. The UI has real accessibility work in
it (`role="log"`, `role="status"`, `role="alert"`, per-paragraph `aria-label`s, a deliberate
`aria-hidden` on the streaming paragraph) and nothing prevented a later change from undoing it.
Nothing watched bundle size, on an app whose main selling point is that text appears fast. And
`npm run build` was the only thing that type-checked, so a type error surfaced at the end of the
slowest step instead of in seconds.

### The bundle-budget manifest doesn't exist as originally planned

The original plan for this work assumed reading `.next/app-build-manifest.json` and
`.next/build-manifest.json` to resolve each route's JS chunks — the webpack-era Next.js shape.
Next 16.3.0 builds with **Turbopack by default**, for both `next dev` and `next build` (confirmed
by running a real production build and inspecting `.next/`). Under Turbopack,
`app-build-manifest.json` does not exist at all, and `build-manifest.json` is an empty
pages-router compatibility shim (`{"pages": {"/_app": []}}`) with no per-route app-router data.

The actual per-route client entry files live in
`.next/server/app/<route>/page_client-reference-manifest.js` — a `.js` file assigning
`globalThis.__RSC_MANIFEST["/<route>/page"] = {...}`, not JSON — under that object's
`entryJSFiles` map, keyed by `"[project]/src/app/<route>/page"`. `scripts/bundle-budget.mts`
reads that instead: it scans braces (rather than regex-matching to a trailing `}`, since the
object could contain `{`/`}` inside a string value) to extract the object literal, then
`JSON.parse`s it. Every step that depends on this shape throws a specific, actionable error
("build manifest shape changed — update scripts/bundle-budget.mts") rather than a bare
`TypeError`, since — as the original plan already anticipated for the *webpack* shape — this is
still not a stable public API and a future Next upgrade could change it again.

## Decision

**Responsive.** Absorbed `scripts/responsive-check.mjs` into Playwright (`e2e/specs/
responsive.spec.ts`) rather than just wiring the standalone script into CI. The script could only
reach `/`, `/story`, `/login`, `/signup`, and a 404 — it had no session, so `/library`, `/feed`,
`/feed/[id]`, and a signed-in `/story` were unreachable. Three new Playwright projects (`mobile`
375×812, `tablet` 768×1024, `desktop` 1440×900) run `responsive.spec.ts` and
`accessibility.spec.ts` only (`testMatch`/`testIgnore` in `e2e/playwright.config.ts`); the journey
specs keep running once, under the existing `chromium` project at its default viewport, so nothing
runs three times over. `e2e/helpers/routes.ts` seeds one shared set of page states — home, login,
signup, 404, `/story` empty/with-paragraphs/error/mid-generation, and signed-in `/library`,
`/feed`, `/feed/[id]` — so the responsive and accessibility specs scan the exact same states
rather than drifting apart.

The tap-target check is scoped to `.tap-target, button, [role="button"], select,
input[type="range"]`, hit-tested (via `elementFromPoint` at the center ±20px) rather than read off
`getBoundingClientRect` directly — carried over from the deleted script's own rationale, and load-
bearing here: `.tap-target` (`src/app/globals.css`) deliberately expands a control's hit area with
an invisible `::after` overlay without changing its visual box, which a plain bounding-box read
cannot see. A literal bounding-box check would fail nearly every `.tap-target`-marked control in
the app despite them being correctly sized for touch, and would also flag native radio/checkbox/
text inputs that WCAG 2.5.8 itself exempts. Auditing this surfaced two controls that should have
carried `.tap-target` and didn't — `ShareToggle` and `ReportButton` — visually and structurally
identical to `AppHeader`'s already-tagged "Sign out" button; both were given the class as part of
this change, since the gate has to be green against a codebase that isn't actually broken.

**Accessibility.** `e2e/specs/accessibility.spec.ts` scans the same checkpoints with
`@axe-core/playwright`, failing only on `serious`/`critical` impact and logging
`moderate`/`minor` to the console — a gate that fires on every contrast nudge gets disabled within
a month, and a disabled gate is worse than an absent one. Runs at mobile and desktop only (skipped
on `tablet`; some violations only appear at one width, and a third viewport wasn't worth the
extra full run). The two ARIA decisions axe can't evaluate — the streaming paragraph's
`aria-hidden` while `role="status"` announces, and the finished-paragraph log's `role="log"`/
`aria-live="polite"` — are asserted directly, once, on the `desktop` project only (not per
viewport; they don't vary by width).

Global `error.tsx` (the thrown-during-render boundary) is not part of the scanned set. Every
currently-reachable "error" surface in the app — the story generation-error banner
(`role="alert"`), `not-found.tsx` — is covered; triggering the actual render-time error boundary
without dedicated crash-test scaffolding (deliberately out of scope) isn't possible through any
existing app path, so it's left out rather than manufactured.

**Bundle budget.** `scripts/bundle-budget.mts` (see Context above for why it doesn't read the
manifest files the original plan named) sums gzipped on-disk chunk sizes per route and compares
against `budgets.json`. Budgeted routes: `/`, `/story`, `/feed`, `/library`. Its own unit tests
(`scripts/bundle-budget.test.mts`) run under a standalone `vitest.scripts.config.mts` — mirroring
`vitest.eval.config.mts`/`vitest.perf.config.mts` — via `npm run test:scripts`, kept out of the
coverage-gated `npm test` project set the same way eval/perf are, and wired into the CI `quality`
job rather than `build`.

Budgets are the measured baseline (production build, 2026-09-07) plus ~10% headroom, rounded:

| Route | Measured (gzip) | Budget |
|---|---|---|
| `/` | 13,764 B | 15,200 B |
| `/story` | 13,903 B | 15,300 B |
| `/feed` | 12,733 B | 14,100 B |
| `/library` | 12,273 B | 13,600 B |

JSON has no comment syntax, so the baseline and measurement date live in `budgets.json`'s own
`_measuredAt`/`_baseline` fields rather than as a true comment.

**Typecheck.** `npm run typecheck` (`tsc --noEmit`) is a new, standalone CI step. `tsconfig.json`
already includes `**/*.ts`/`**/*.mts` across `evals/`, `test-support/`, `e2e/`, and `scripts/` —
intentionally, so this one command covers all of it.

**CI wiring.** A new `quality` job runs parallel to `build` and `e2e`: `npm run typecheck`,
`npm run test:scripts`, `npm run build`, `npm run bundle-budget`. It is parallel, not chained
after `build`, so the value of a fast, standalone typecheck step is a fast *signal* on the overall
run (the `quality` job can go red in seconds) rather than shortening `build`'s own critical path —
`next build` still type-checks as part of its own compile regardless. The responsive and
accessibility specs are Playwright projects added to the existing `e2e` job rather than a new one:
they need the same app server, database, and Neon proxy that job already stands up, and duplicating
that infrastructure to run them separately would double the slowest part of CI for no benefit.

## Consequences

Auditing every currently-existing route against the new tap-target gate is a one-time cost this
change already paid (finding and fixing `ShareToggle`/`ReportButton`); a future control that skips
`.tap-target` where it should carry it will now be caught before merge instead of silently
shipping. The same is true of the two ARIA decisions in `story/page.tsx` — they were previously
protected only by a comment.

**Named gap:** no runtime performance measurement (Core Web Vitals, real-device timing) exists
until there's a deployment to measure against — the bundle-budget check is a build-time proxy for
"loads fast," not a substitute for measuring it. Revisit in v4 alongside a real deployment target.

**Named gap:** the global `error.tsx` render-time error boundary has no accessibility coverage,
because nothing in the current app can trigger it without added crash-test scaffolding. If that
scaffolding is ever added for another reason, extend `accessibility.spec.ts` to cover it then.

A Next upgrade that changes Turbopack's client-reference-manifest shape again will surface as a
clear, named failure in `scripts/bundle-budget.mts` rather than a silent pass or a bare
`TypeError` — by design, but it does mean this script has a second dependency (this internal
manifest shape, not just budgets.json's numbers) to revisit on every major Next upgrade.
