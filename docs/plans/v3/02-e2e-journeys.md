# Plan 2 — E2E journey tests

**Branch:** `feature/e2e-journeys`
**Depends on:** Plan 1, for `test-support/mock-provider/` and the adapter base-URL overrides.
**ADR:** required.

## Why this exists

The repo has 158 tests and none of them run the app. `src/lib/story/StoryContext.tsx` — the
reducer, the abort handling, the lazy story creation, the silent retry — is explicitly excluded
from coverage in `vitest.config.mts` and tested by nothing. No component is tested. No page is
tested. Every v2 success criterion in `docs/PRD.md` §8 is asserted in prose and verified by
hand.

This plan makes those criteria executable.

## What "done" means

- `npm run test:e2e` boots a production build against a real Postgres, through the **real Neon
  HTTP driver**, with the provider replaced by a scripted mock, and drives the browser through
  every journey below.
- A dedicated `e2e` job in CI runs it on every PR and must pass to merge.
- Each of `docs/PRD.md` §8's five v2 success criteria maps to a named spec.

## If Plan 1 isn't merged yet

Build `test-support/mock-provider/` and the three adapter base-URL overrides here instead,
exactly as specified in Plan 1, and note in the PR that Plan 1 will consume them.

## The database problem — read this before writing anything

`src/lib/db/client.ts` uses `@neondatabase/serverless`, which speaks Neon's HTTP protocol, not
the Postgres wire protocol. **It cannot connect to a plain Postgres.** The `db` Vitest project
sidesteps this by injecting a `node-postgres` handle through `__setDbForTests` — a seam that
does not exist for a real server process.

Do not add a driver switch to `client.ts` to work around this. Instead run the Neon HTTP proxy
in front of Postgres, exactly as `README.md` already documents:

```bash
docker run -d --name fabula-e2e-neon-proxy -p 4444:4444 \
  -e PG_CONNECTION_STRING="postgres://postgres:postgres@host.docker.internal:5432/fabula_e2e" \
  ghcr.io/timowilhelm/local-neon-http-proxy:main
```

and point the app under test at it:

```
DATABASE_URL=postgres://postgres:postgres@db.localtest.me:4444/fabula_e2e
NEON_FETCH_ENDPOINT=http://db.localtest.me:4444/sql
```

This is not a workaround, it is the point: `docs/adr/0014` names driver parity as a known risk,
and this is the only harness in the repo that exercises the driver production actually uses.
Say so in the ADR.

In CI the proxy is a `services:` container; note that `host.docker.internal` does not resolve
on Linux runners — use the job's Postgres service hostname on the CI-provided network instead,
and verify the proxy comes up before Playwright starts.

## Setup

Add `@playwright/test` (the runner; bare `playwright` is already a devDependency and is not
enough). Add `@axe-core/playwright` only in Plan 6, not here.

```
e2e/
  playwright.config.ts
  global-setup.ts        # create + migrate fabula_e2e, start the mock provider
  global-teardown.ts
  helpers/
    db.ts                # truncate tables between specs (node-postgres, like src/test/)
    auth.ts              # signUp(page, email), signIn(page, email), uniqueEmail()
    story.ts             # writeParagraph(page, text), waitForAiParagraph(page, n)
    mock.ts              # set the mock provider's script for the current spec
  specs/
    guest-write.spec.ts
    turn-policy.spec.ts
    account-library.spec.ts
    guest-adoption.spec.ts
    resume-story.spec.ts
    sharing-feed.spec.ts
    reporting.spec.ts
    auth-gates.spec.ts
    rate-limit.spec.ts
    provider-failure.spec.ts
```

`playwright.config.ts`:

- `webServer` entries for the built app (`npm run build && npm run start -- -p 3111`) with the
  env above plus `ANTHROPIC_BASE_URL` pointed at the mock provider, and
  `ANTHROPIC_API_KEY=e2e-key` (the SDK requires a non-empty string even when the base URL is
  local);
- `AUTH_SECRET` set to a fixed test value, `AUTH_URL`/`NEXTAUTH_URL` at `http://localhost:3111`;
- `fullyParallel: false` and `workers: 1` — the specs share one database and one mock server,
  and the rate-limit spec deliberately exhausts a global bucket. Revisit only if a
  worker-scoped database is added later;
- `retries: 1` on CI, `0` locally;
- `trace: "retain-on-failure"`, `video: "retain-on-failure"`;
- one `chromium` project for now (Plan 6 adds the viewport projects).

Reuse `src/test/db-names.ts` and `src/test/global-setup-db.ts` for the migrate-a-template
logic rather than reimplementing it — read them first and extract anything shared rather than
copying.

## Isolation between specs

`helpers/db.ts` exposes `resetDatabase()`, called in a `beforeEach`. It must truncate
`story_report`, `story_paragraph`, `story`, `rate_limit_bucket`, `session`, `account`, and
`user` — in dependency order, or use `TRUNCATE ... CASCADE`.

**`rate_limit_bucket` is the one people forget.** The rate-limit spec exhausts the guest bucket
for the loopback address; every later spec then 429s. Truncating it between specs is mandatory,
and there should be a comment saying why.

Every spec that creates an account must use `uniqueEmail()` — the `user.email` unique
constraint plus `onConflictDoNothing` in the register route means a reused address silently
produces a no-op signup and a confusing auth failure downstream.

## The journeys

Each maps to a spec file. Name the tests after the behaviour, not the mechanics.

**`guest-write.spec.ts`** — PRD §5 happy path, no account.
Land on `/`. Submit with nothing filled in. Assert the AI paragraph streams (text present and
growing, then settled), the invented theme/characters chip renders from the metadata sentinel,
and the paragraph is attributed to the provider's display name. Write a paragraph, click
continue, assert the Writer paragraph and then the AI reply both land, in order. Click
"New story" and assert the canvas is empty and state is reset.

**`turn-policy.spec.ts`** — ADR 0004.
After the AI's paragraph, assert the continue affordance is unavailable until the Writer has
typed something; assert an empty/whitespace draft cannot be submitted. Then, at the API level
(`request.post` with a `storySoFar` ending in an AI paragraph), assert a 409 and the
turn-violation message, and assert the UI renders that error with **no** "Try again" button.

**`account-library.spec.ts`** — PRD §8 criteria 1 and 2.
Sign up → assert redirected in as the new user. Write a story of three paragraphs. Navigate to
`/library`. Assert the story is listed with the right paragraph count and theme. Reload with a
fresh browser context (same storage state) and assert it is still there.

**`guest-adoption.spec.ts`** — PRD §8 criterion 3. The subtlest one.
Write two paragraphs as a guest. Sign in from the header without leaving the story. Continue
writing. Assert that `/library` now contains a story whose paragraph count includes the
paragraphs written *before* sign-in — the backlog is persisted by `/api/generate`'s diff-based
sync on the next turn (`syncStoryParagraphs`), not by an import step. Assert paragraph order
and authorship are intact.

**`resume-story.spec.ts`** — PRD §8 criterion 2, resume half.
From `/library`, open a saved story. Assert `/story?storyId=…` hydrates every paragraph in
order with correct attribution, and that the theme/characters/target length came back. Continue
writing and assert the new paragraph is appended at the correct position (not duplicated, not
at position 0).

**`sharing-feed.spec.ts`** — PRD §8 criterion 4.
Account A shares a story. Account B (separate browser context) sees it in `/feed` with A's name
and the paragraph count, opens it, and gets a read-only view — assert there is no compose
textarea and no continue control. A unshares; B refreshes; it is gone. Also assert the
unmoderated-content disclaimer required by ADR 0010 is present on the shared view.

**`reporting.spec.ts`** — PRD §8 criterion 5.
B reports A's shared story. Assert success. Report again and assert it is a no-op, not an error
— the UI must not show a failure, and the API must not 500 (the unique constraint on
`(storyId, reporterId)` is what makes this idempotent).

**`auth-gates.spec.ts`** — `src/proxy.ts`.
Logged out, visit `/library` and `/feed`; assert redirect to `/login` with the `callbackUrl`
query param set to the original path. Sign in; assert you land back on the requested page.
Assert `/` and `/story` remain reachable logged out — guest writing must never be gated.

**`rate-limit.spec.ts`** — ADR 0015.
Drive `/api/generate` past `GENERATE_GUEST.capacity` (5) via `request.post`. Assert 429 with a
`Retry-After` header of at least 1. Then assert the UI renders the rate-limited message with
**no** "Try again" button. Run this spec last, or rely on the `beforeEach` truncate — but state
the dependency in a comment either way.

**`provider-failure.spec.ts`** — the error paths, using the mock's `error` / `truncate` /
`hang` response kinds from Plan 1.
- Mock returns HTTP 500 before any chunk → assert a 502 from the route, and the UI error banner
  with a working "Try again".
- Mock streams two chunks then destroys the socket → assert the client's single silent
  auto-retry fires (assert exactly two upstream calls were made, via a counter on the mock),
  and that a successful retry produces one paragraph, not two.
- Mock hangs → currently there is no server-side timeout, so **assert today's behaviour** and
  leave a `TODO(plan-04)` comment. Plan 4 replaces this assertion; wiring it now means Plan 4
  has a failing test to make pass.

## Assertions to avoid

- Do not assert on Tailwind class names or DOM structure. Query by role, label, and text —
  the a11y attributes are already in place (`role="log"`, `role="status"`, `role="alert"`,
  the per-paragraph `aria-label`), and using them keeps the specs honest about accessibility.
- Do not `waitForTimeout`. Wait for the settled paragraph count or for the streaming indicator
  to disappear. The mock server's `delayMs` gives you deterministic streaming timing.
- Do not assert exact generated prose beyond what the mock script sets — the point of the mock
  is that the text is yours to choose.

## CI

Add a separate `e2e` job to `.github/workflows/ci.yml`, parallel to `build` so it doesn't
serialise the pipeline:

- `services:` Postgres 17-alpine (same config as the existing job) **and** the Neon HTTP proxy
  image pointed at it;
- same Node 22 + `npm i -g npm@11` + `npm ci` preamble;
- `npx playwright install --with-deps chromium`, with `actions/cache` on
  `~/.cache/ms-playwright` keyed on the `@playwright/test` version from the lockfile;
- `npm run test:e2e`;
- `actions/upload-artifact@v4` with `if: failure()` for `playwright-report/` and `test-results/`.

Make the job required for merge. Then update `AGENTS.md`'s CI-reproduction bullet list to
include `npm run test:e2e` — that list is normative and must not drift.

## Scripts

```json
"test:e2e":     "playwright test",
"test:e2e:ui":  "playwright test --ui"
```

Add `e2e/.playwright/`, `playwright-report/`, and `test-results/` to `.gitignore`.

## Gotchas

- `next build` runs during `webServer` startup and is slow. Set `webServer.timeout` to at least
  180s and `reuseExistingServer: !process.env.CI` so local iteration doesn't rebuild each run.
- Auth.js v5 with `strategy: "jwt"` sets an httpOnly cookie; Playwright's `storageState` handles
  it, but the cookie name differs between HTTP and HTTPS (`authjs.session-token` vs
  `__Secure-…`). Tests run over HTTP; don't hardcode the secure name.
- Google OAuth is not testable here and must not be attempted. Cover email/password only, and
  say so in the ADR — this is a named coverage gap, not an oversight.
- `src/app/story/page.tsx` reads `useSearchParams()` inside a `Suspense` boundary. Wait for the
  hydrated content, not for `networkidle`, which streaming responses can defeat.
- `getDb()` memoises the client in module scope. The app server holds one connection config for
  its whole life; changing env between specs will not take effect. Everything the specs vary
  must be varied through the mock provider's script, not through app env.
- The register route hashes with bcrypt cost 12 on every signup. That's ~300ms each; keep the
  number of accounts per spec small or the suite crawls.

## Out of scope

- Cross-browser (Firefox/WebKit) runs. Chromium only.
- Visual regression / screenshot diffing.
- Axe accessibility scans and viewport projects — those are Plan 6, which absorbs
  `scripts/responsive-check.mjs` into this harness.
- Load or latency testing.

## ADR

`docs/adr/00NN-end-to-end-test-strategy.md`. Cover:

- Why the seam is the provider's base URL rather than a registry stub or browser-level
  interception — the route, persistence, rate limiting, and the streaming protocol are all
  things that have broken before and all of them are downstream of a browser-level mock.
- Why the E2E stack runs the Neon HTTP driver through a proxy instead of injecting
  `node-postgres`, and what ADR 0014 risk that closes.
- Why the suite is serial and truncates between specs, including the `rate_limit_bucket` trap.
- The named gaps: Google OAuth, cross-browser, visual regression.
