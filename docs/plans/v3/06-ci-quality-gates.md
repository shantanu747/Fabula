# Plan 6 — CI quality gates: responsive, accessibility, bundle budget, typecheck

**Branch:** `feature/ci-quality-gates`
**Depends on:** Plan 2 (absorbs the Playwright harness). Land last.
**ADR:** required.

## Why this exists

Three checks the repo already believes in are not actually enforced:

- `AGENTS.md` makes responsive layout a hard requirement and `scripts/responsive-check.mjs`
  exists to verify it — and CI never runs it. It only runs if someone remembers.
- The UI has real accessibility work in it (`role="log"`, `role="status"`, `role="alert"`,
  per-paragraph `aria-label`s, `sr-only` status lines, a deliberate `aria-hidden` on the
  streaming paragraph) and nothing prevents the next change from undoing it.
- Nothing watches bundle size, on an app whose main selling point is that text appears fast.

Plus `npm run build` is currently the only thing that type-checks, so type errors surface at the
end of the slowest step.

## What "done" means

- Responsive checks run in CI at 375/768/1440 and fail on horizontal overflow or undersized tap
  targets.
- Axe scans run in CI on every route and fail on serious/critical violations.
- First-load JS for `/` and `/story` is measured against a committed budget.
- `tsc --noEmit` runs as its own fast step, before the slow ones.
- `AGENTS.md`'s CI-reproduction list matches reality.

## 1. Absorb the responsive script into Playwright

`scripts/responsive-check.mjs` does the right check (`scrollWidth - clientWidth`, plus tap-target
sizing) but it is a standalone script needing a manually started server, and it only visits `/`,
`/story`, `/login`, `/signup`, and a 404. It cannot reach `/library`, `/feed`, or a story with
paragraphs in it, because those need a session and state — which is exactly what Plan 2's
harness provides.

Move it in:

- Add `mobile` (375×812), `tablet` (768×1024), and `desktop` (1440×900) projects to
  `e2e/playwright.config.ts`.
- New spec `e2e/specs/responsive.spec.ts` that, for each route, asserts
  `document.documentElement.scrollWidth <= clientWidth` and that every interactive element
  (`button`, `a[href]`, `input`, `textarea`, `select`, `[role="button"]`) has a bounding box at
  least 44×44 CSS px — carry over the existing script's threshold and its rationale comment.
- Cover the routes the old script couldn't: signed-in `/library`, `/feed`, `/feed/[id]`, and
  `/story` mid-generation **and** in the error state — the two-button failover row from Plan 4
  is a genuine overflow risk at 375px and is the reason this spec is worth having.
- Delete `scripts/responsive-check.mjs`, remove `test:responsive` from `package.json`, and
  update the `README.md` line that documents it. Do not leave both.

Keep the full-page screenshots as Playwright artifacts on failure — that was the useful half of
the old script.

## 2. Accessibility

Add `@axe-core/playwright`. New spec `e2e/specs/accessibility.spec.ts`:

- Scan `/`, `/login`, `/signup`, `/story` (empty, mid-stream, with paragraphs, and in the error
  state), `/library`, `/feed`, `/feed/[id]`, `not-found`, and `error`.
- Fail on `serious` and `critical` impact. Report `moderate` and `minor` to the console without
  failing — a gate that fires on every minor contrast nudge gets disabled within a month.
- Scan at mobile and desktop widths; some violations only appear at one.
- Any rule you must disable gets an inline comment with the reason and the route, not a bare
  entry in a config array. If the list grows past three, that's a signal to fix the UI instead.

Two specific checks worth asserting directly, because axe cannot see them and they are the
accessibility decisions the code deliberately made:

- the streaming paragraph carries `aria-hidden="true"` while it fills in, and the `role="status"`
  line announces instead;
- the finished-paragraph container keeps `role="log"` with `aria-live="polite"`.

Both have explanatory comments in `src/app/story/page.tsx` today. A test is what keeps them true.

## 3. Bundle budget

New `scripts/bundle-budget.mjs`, run after `next build`:

- Read `.next/app-build-manifest.json` and `.next/build-manifest.json` to resolve the JS chunks
  for each route entry.
- Sum the **gzipped** on-disk size of those chunks (`node:zlib` `gzipSync` on the file contents)
  — raw bytes overstate what users actually download and make the budget meaningless.
- Compare against `budgets.json` at the repo root.
- Print a table of route → size → budget → delta, and exit non-zero on any overage.

Budget the routes that matter: `/`, `/story`, `/feed`, `/library`.

**Measure before you write the numbers.** Run a production build on a clean `main`, record the
actual sizes, and set each budget to roughly the measured value plus 10% headroom. A budget
invented from a blog post either fires immediately or never fires. Put the measured baseline and
the date in a comment in `budgets.json`.

The manifest format is not a stable public API. Assert the shape you rely on and fail with a
clear message ("build manifest shape changed — update scripts/bundle-budget.mjs") rather than a
`TypeError` on `undefined`, so a Next upgrade produces a comprehensible failure.

## 4. Typecheck as its own step

```json
"typecheck": "tsc --noEmit"
```

`tsconfig.json` already has `"noEmit": true`, so this is a fast, standalone check. Put it
immediately after `npm run lint` in CI — before tests and the build — so a type error fails in
seconds instead of minutes.

Note that `tsconfig.json` includes `**/*.ts` and `**/*.mts`, which means `evals/`,
`test-support/`, `e2e/`, and the new script are all in scope. That's intended. If any of them
resist type-checking, fix them rather than narrowing the include.

## 5. CI wiring

`.github/workflows/ci.yml` gains a `quality` job, parallel to `build` and the `e2e` job from
Plan 2, so total wall-clock doesn't grow much:

- Node 22 + `npm i -g npm@11` + `npm ci` preamble, matching the existing jobs.
- `npm run typecheck`
- `npm run build` then `node scripts/bundle-budget.mjs`

The responsive and accessibility specs are Playwright projects and belong in the existing `e2e`
job, not a new one — they need the same server, database, and Neon proxy, and standing all that
up twice would double the slowest part of CI.

Mark `e2e` and `quality` as required for merge alongside `build`.

Then update `AGENTS.md`'s bullet listing the CI steps to reproduce locally. That list is
normative and currently reads `npm run lint`, `npm test`, `npx drizzle-kit check`,
`npm run test:coverage`, `npm run build`. After Plans 1, 2, and 6 it must also include
`npm run typecheck`, `npm run eval`, `npm run test:e2e`, and the bundle-budget script — in the
order CI runs them. Leaving that list stale is the same class of error as a stale ADR.

## Tests

- `scripts/bundle-budget.test.mjs` (or a spec under `evals`-style standalone config): the size
  computation and the over/under comparison, against a fixture manifest. Do not run a real build
  in a unit test.
- The responsive and accessibility specs are themselves the tests. Verify each fails for the
  right reason before you trust it — temporarily add a `min-width: 900px` element and confirm the
  responsive spec catches it at 375px; temporarily strip an `aria-label` and confirm axe fires.
  Say in the PR that you did this. A green gate that cannot fail is worse than no gate.

## Gotchas

- Axe on a streaming page is timing-sensitive. Scan at a settled state — after the paragraph
  lands, or with the mock provider's `delayMs` set high enough to hold a stable mid-stream frame.
- The 44px tap-target rule will flag inline text links, which is a false positive for prose
  links. Scope the assertion to controls (`button`, `[role="button"]`, form inputs, and links
  styled as buttons — the codebase marks those with a `tap-target` class already; use it).
- Adding Playwright projects multiplies runtime by the number of viewports. Run the *journey*
  specs on desktop only and the responsive/accessibility specs across all three, via
  `testMatch`/`testIgnore` per project. Do not run everything three times.
- `next build` output differs between a cold and cached `.next`. The bundle-budget script must
  run against a fresh build in CI; locally, `rm -rf .next` before trusting a number.
- Deleting `scripts/responsive-check.mjs` while `README.md` and `package.json` still reference it
  is the easy miss here. Grep for `responsive` across the repo before you finish.

## Out of scope

- Lighthouse or Core Web Vitals scoring in CI — noisy on shared runners, and the useful signal
  needs a real deployment (v4).
- Load or latency testing.
- Visual regression / screenshot diffing.
- Fixing accessibility violations the scan uncovers beyond serious/critical — if it finds a
  large backlog, record it and scope a follow-up rather than expanding this branch.

## ADR

`docs/adr/00NN-ci-quality-gates.md`. Cover:

- Why each gate fails at the threshold it does (axe at serious/critical, `npm audit` at high in
  Plan 5, bundle budget at measured+10%) — the common thread is that a gate which fires on noise
  gets disabled, and a disabled gate is worse than an absent one.
- Why the responsive script was absorbed into Playwright rather than kept and merely wired to
  CI: it needed a session to reach half the app's routes.
- Why the responsive/accessibility specs share the `e2e` job while the bundle budget gets its
  own, and the wall-clock reasoning.
- The measured bundle baseline and date.
- The named gap: no runtime performance measurement until there's a deployment.
