# Fabula v3 — implementation plans

Six features, one branch each, implemented one at a time. These plans are written to be
executed by an agent with no prior context on the conversation that produced them.

## Rules that apply to every plan on this list

1. **Read `AGENTS.md` first, in full.** Everything in it applies. In particular: read the
   relevant guide under `node_modules/next/dist/docs/` before writing Next.js-specific code
   — this is Next 16.3 and the APIs differ from training data. Note that `middleware.ts` is
   now `proxy.ts` in this version.
2. **The completion bar is CI, reproduced locally.** Before calling any of these done, run
   every step `.github/workflows/ci.yml` runs, in order, with CI's exact job-level env:
   ```
   npm run lint
   npx drizzle-kit check
   npm run test:coverage
   npm run build
   ```
   with `ANTHROPIC_API_KEY=test-key OPENAI_API_KEY=test-key OPENROUTER_API_KEY=test-key
   DATABASE_URL=postgres://user:pass@localhost:5432/fabula AUTH_SECRET=ci-placeholder-secret`
   set at job level, and a real Postgres reachable for the `db` project:
   ```
   docker run -d --name fabula-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
   ```
   Setting `DATABASE_URL` matters even for tests that seem not to need it — a rate-limit-guarded
   route test has already passed locally with it unset and failed in CI with it set.
   If a plan adds a CI step, that new step joins this list.
3. **Every plan ends in an ADR** under `docs/adr/`, in the format described in
   `docs/adr/README.md` (Status / Context / Decision / Consequences), plus a new line in that
   file's index. Take the next unused number at the time you branch; if two branches claim the
   same number, the later one to merge renumbers.
4. **Do not expand scope.** Each plan has an explicit "Out of scope" section. If implementing
   one surfaces a genuine gap in the spec, stop and flag it rather than improvising.
5. **Coverage thresholds in `vitest.config.mts` are tiered and enforced.** `src/lib/story/**`,
   `src/lib/ratelimit/**`, and `src/lib/providers/{prompt,registry,list,constants,types}.ts`
   are held at 100%. Adding an untested line to any of those fails CI. If you add a new
   directory under `src/lib/`, decide its tier deliberately and say why in the PR.
6. **Fill in `.github/pull_request_template.md` honestly.** "Tests pass" is not an answer to
   the Testing section.

## Merge order (not arbitrary — three of these share dependencies)

| # | Branch | Depends on |
|---|---|---|
| 1 | `feature/llm-eval-harness` | — (builds the mock provider server + adapter base-URL overrides that 2 reuses) |
| 2 | `feature/e2e-journeys` | 1, for the mock provider server |
| 3 | `feature/otel-observability` | — (but widens the provider return type; easier before 4) |
| 4 | `feature/provider-failover-prompt` | 3 (same interface), 2 (for its E2E specs) |
| 5 | `feature/security-headers` | 2 (for its header/CSP-violation E2E specs) |
| 6 | `feature/ci-quality-gates` | 2 (absorbs the Playwright harness), and lands last |

If you must go out of order, each plan's "If the dependency isn't merged yet" note says what
to do.

## The plans

1. [LLM eval harness](01-llm-eval-harness.md) — prompt-contract snapshots, recorded-fixture
   replay, a pinned judge model, and a nightly live drift check.
2. [E2E journey tests](02-e2e-journeys.md) — Playwright over a real build, real Postgres, real
   Neon driver, and a scripted provider.
3. [OpenTelemetry observability](03-otel-observability.md) — traces, structured logs, token/cost
   accounting, TTFT, and `/api/health`.
4. [Provider failover prompt](04-provider-failover-prompt.md) — server-side timeouts and an
   ask-the-Writer-before-switching recovery flow.
5. [Security headers and supply chain](05-security-headers.md) — nonce-based CSP via `proxy.ts`,
   static security headers, Dependabot, CodeQL, `npm audit`.
6. [CI quality gates](06-ci-quality-gates.md) — responsive and axe checks in CI, a bundle-size
   budget, and an explicit typecheck step.
