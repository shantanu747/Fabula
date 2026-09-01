# 19. End-to-end test strategy

## Status

Accepted.

## Context

The repo has 158 unit/db tests and none of them run the app. `src/lib/story/StoryContext.tsx` — the reducer, the abort handling, the lazy story creation, the silent retry — is explicitly excluded from coverage in `vitest.config.mts` and tested by nothing. No component is tested. No page is tested. Every v2 success criterion in `docs/PRD.md` §8 is asserted in prose and verified by hand.

This plan (`docs/plans/v3/02-e2e-journeys.md`) makes those criteria executable: a production build, a real Postgres through the real Neon HTTP driver, and a scripted provider, driven through a real browser.

## Decision

**The seam is the provider's base URL, not a registry stub or browser-level interception.** Each adapter already reads `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`OPENROUTER_BASE_URL` (added for the eval harness, ADR 0018) and, when set, points the real SDK at `test-support/mock-provider/`. The E2E harness reuses this unchanged: the route, persistence, rate limiting, and the streaming/metadata-sentinel protocol are all things that have broken before, and all of them are downstream of a browser-level mock (which would only ever prove the DOM renders what a canned `fetch` response says, not that `/api/generate` actually produces that response). Routing at the HTTP boundary of the provider SDK keeps every one of those layers in the exercised path.

**The mock provider needs a remote-control channel it didn't have.** `startMockProvider()`'s `setScript(fn)` is an in-process JS callback, fine for Vitest/eval (same process as the test). E2E can't use it as-is: Playwright's `webServer` (the app under test) reads `ANTHROPIC_BASE_URL` once at startup and must already be pointed at a live mock, which means the mock has to be started in `globalSetup` — Playwright's documented guarantee is that `globalSetup`/`globalTeardown` run in the root process, but every spec file runs in a separate worker process. A worker process cannot call `.setScript()` on an object that lives in a different process's memory. `test-support/mock-provider/server.ts` gained an opt-in HTTP control plane (`MockProviderOptions.remoteControl`) — `POST /__mock/queue` installs a FIFO response queue (the last entry repeats once exhausted, so a spec can install either a fixed reply or a short sequence like "truncate, then succeed on retry" without predicting call counts), `POST /__mock/reset`, and `GET /__mock/calls` for assertions like "the retry made exactly two upstream calls". This is additive and off by default — Vitest/eval usage (`test-support/mock-provider/server.test.ts`, the eval harness) is untouched.

**The database runs the real Neon HTTP driver through a proxy, not an injected node-postgres handle.** `src/lib/db/client.ts` speaks Neon's HTTP protocol via `@neondatabase/serverless`, which cannot reach a plain Postgres at all. The `db` Vitest project sidesteps this with `__setDbForTests`, a seam that doesn't exist (and shouldn't — it's `NODE_ENV`-guarded against production use) for a real `next start` server process. ADR 0014 named this gap explicitly: driver parity is a known risk, and nothing before this harness exercised the driver production actually uses. `e2e/global-setup.ts` creates and migrates a `fabula_e2e` database directly against Postgres (reusing the migration logic from `src/test/global-setup-db.ts`, not the template-clone lifecycle around it — E2E runs one database for the whole serial suite, not one per worker), then verifies the Neon HTTP proxy (`ghcr.io/timowilhelm/local-neon-http-proxy`, documented in `README.md`) is reachable in front of it. The app's own `DATABASE_URL`/`NEON_FETCH_ENDPOINT` point at that proxy. This closes the exact gap ADR 0014 flagged as future work.

**The suite is serial (`workers: 1`, `fullyParallel: false`) and truncates between every test, not just every file.** All ten spec files share one database and one mock server; `rate-limit.spec.ts` deliberately exhausts a global rate-limit bucket. `helpers/db.ts`'s `resetDatabase()` truncates `story_report`, `story_paragraph`, `story`, `rate_limit_bucket`, `session`, `account`, and `user` (`CASCADE`) in every spec's `beforeEach`. **`rate_limit_bucket` is the trap**: every guest request in this suite shares one bucket identity, because `clientIp()` (`src/lib/ratelimit/policy.ts`) falls back to `"unknown"` when there's no `x-forwarded-for`/`x-real-ip` header, which Playwright never sends. Without the truncate, whichever spec runs after `rate-limit.spec.ts` would silently start 429ing. Truncating before every test (not once per file) means spec run order is not load-bearing — belt-and-suspenders, since Playwright's default order is deterministic but not a contract worth depending on.

## Named gaps

- **Google OAuth is untested.** It's not testable headlessly against a real Google account in CI, and simulating it would mean not testing the real thing. Only Credentials (email/password) sign-in is covered.
- **Cross-browser (Firefox/WebKit) and visual regression** are out of scope — Chromium only, no screenshot diffing.
- **Provider hang has no server-side timeout to test yet.** `provider-failure.spec.ts`'s hang case asserts *today's* behavior (the request never settles) rather than a timeout, with a `TODO(plan-04)` — Plan 4 adds the timeout and will need to flip this assertion, deliberately left failing-by-design for that plan rather than skipped.
- **Viewport/responsive projects and axe accessibility scans** are Plan 6's job, which also absorbs `scripts/responsive-check.mjs` into this harness.

## Consequences

`npm run test:e2e` (CI: the `e2e` job, parallel to `build`) now proves, against a production build and a real Postgres, what previously lived only in `docs/PRD.md` §8's prose: signup/signin/signout, a signed-in story surviving a closed tab, guest-to-account adoption without a manual import step, share/unshare visibility across accounts with the proxy-enforced auth gate, and idempotent reporting. `src/lib/story/StoryContext.tsx` stays out of the Vitest coverage thresholds (see the exclusion comment in `vitest.config.mts`) — that exclusion's rationale ("exercised through the UI, not through this suite") is now literally true for the first time.

The tradeoff: this suite is slow (a full `next build` per run, `bcrypt` cost-12 hashing on every signup) and depends on Docker (Postgres + the Neon proxy) being available, so it is a merge gate, not a fast inner-loop check — `npm test` remains that.

## Rejected

- **Browser-level `fetch`/route interception for every generation call** — would validate the DOM against a response the test itself invented, without proving `/api/generate` produces it. (`turn-policy.spec.ts` does use `page.route()` for one specific case — forcing the client's rendering of a 409 it cannot otherwise reach through honest UI interaction, since the Continue button is legitimately disabled the rest of the time — but that's deliberately narrow: the same scenario is separately proven server-side via a raw `request.post`.)
- **A worker-scoped fixture to start the mock provider** — would run in the correct (worker) process for specs to control it directly, but Playwright's `webServer` starts before any worker exists, and the app needs the mock's URL at that point. The ordering constraint forced the mock into the root process, which forced the remote-control channel.
- **Dropping `fabula_e2e` in global-teardown** — left in place between local runs (global-setup drops-and-recreates it with `WITH (FORCE)` on the next run, same as the `db` project's template) so a failed run's data is inspectable afterward.
