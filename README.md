# Fabula

Fabula is a web app for co-writing short fiction with an AI collaborator. A Writer optionally sketches a theme, starter characters, and opening lines, then alternates one paragraph at a time with an AI — either side can kick the story off, and the AI steers toward a climax and resolution as the story approaches its target length.

- **Model-agnostic by design** — every AI turn goes through a single `LLMProvider` interface, with interchangeable adapters for Anthropic, OpenAI, and an open-weight model via OpenRouter. Switching providers mid-story loses no state.
- **Streaming, not spinners** — paragraphs render as they're generated.
- **Guest-first** — the core write flow (`/`, `/story`) needs no account. Signing in adds a persisted library and an opt-in shared feed on top, without gating the base experience.

## Stack

Next.js 16.3 (App Router) · TypeScript · Tailwind CSS v4 · React 19 · Postgres (Neon) via Drizzle ORM · Auth.js v5 (email/password + Google)

## Documentation

This repo treats docs as the source of truth for scope and reasoning, not an afterthought:

- [`docs/PRD.md`](docs/PRD.md) — what Fabula does and why, v1 and v2 goals, non-goals.
- [`docs/use-cases.md`](docs/use-cases.md) — exact user-facing flows.
- [`docs/architecture.md`](docs/architecture.md) — system overview: directory layout, request lifecycle, provider abstraction, persistence/auth boundaries.
- [`docs/adr/`](docs/adr/) — Architecture Decision Records explaining the reasoning, tradeoffs, and rejected alternatives behind non-obvious technical decisions (provider abstraction, streaming protocol, turn policy, context windowing, content safety defaults, client state, accounts/persistence, shared feed safety, and a post-implementation security hardening pass).

## Getting started

### Prerequisites

- Node.js 20+
- npm 11+ (required for proper dependency resolution)
- A Postgres database (a free [Neon](https://neon.tech) project works well) — only required for accounts, saved stories, and the shared feed; guest writing works without it.

### Setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Required for |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | AI generation (at least one provider) |
| `DATABASE_URL` | Accounts, saved stories, shared feed |
| `AUTH_SECRET` | Auth.js session/JWT signing — generate with `npx auth secret` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google" (email/password works without it) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis-backed concurrency admission and daily spend caps ([`docs/adr/0035`](docs/adr/0035-redis-as-a-non-authoritative-tier.md)) — entirely optional, the app falls back to Postgres-only rate limiting with no caps beyond that |
| `TRUSTED_PROXY_HOP_COUNT` | Only if self-hosting behind a proxy other than Vercel's — defaults to 1 |
| `CRON_SECRET` | Only if `vercel.json`'s `rate_limit_bucket` pruning cron is scheduled |

If you're using a database, generate and apply the schema:

```bash
npm run db:generate   # only needed after a schema change
npm run db:migrate
```

Then run the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Other scripts

```bash
npm run lint            # ESLint
npm run build           # production build
npm test                # unit + db suites
npm run test:unit       # no database needed
npm run test:db         # needs Postgres (see below)
npm run test:coverage   # enforces the tiered thresholds in vitest.config.mts
npm run test:perf       # EXPLAIN suite; seeds ~100k rows, run after index changes
npm run typecheck       # tsc --noEmit, standalone so a type error fails in seconds
npm run test:scripts    # unit tests for the standalone scripts (e.g. bundle-budget)
npm run bundle-budget   # after `next build` — checks first-load JS against budgets.json
```

Responsive layout (mobile/tablet/desktop) and accessibility (axe) checks live in
`e2e/specs/responsive.spec.ts` and `e2e/specs/accessibility.spec.ts` — part of
`npm run test:e2e`, not a separate script, since they need the same signed-in
sessions and mock provider the rest of that suite already sets up.

### Running the tests that need a database

The `db` and `perf` suites run against a real Postgres, because what they test is
what Postgres does — the unique constraint that serialises concurrent turns, and
the plans the query planner actually picks. Start one:

```bash
docker run -d --name fabula-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:17-alpine
```

That matches the default; set `TEST_DATABASE_URL` to point somewhere else. The
suite builds a template database by running the migrations and clones it per
worker, so nothing you care about is touched.

### Developing against a local database

The app uses Neon's HTTP driver, which speaks Neon's protocol rather than the
Postgres wire protocol and so cannot connect to a local Postgres directly. To run
the real driver locally, put a Neon HTTP proxy in front of it and point
`NEON_FETCH_ENDPOINT` at it:

```bash
docker run -d --name fabula-neon-proxy -p 4444:4444 \
  -e PG_CONNECTION_STRING="postgres://postgres:postgres@host.docker.internal:5432/fabula_dev" \
  ghcr.io/timowilhelm/local-neon-http-proxy:main

DATABASE_URL="postgres://postgres:postgres@db.localtest.me:4444/fabula_dev" \
NEON_FETCH_ENDPOINT="http://db.localtest.me:4444/sql" npm run dev
```

This is worth the setup: the test suite runs on `node-postgres`, and this is the
only way to exercise the driver that production actually uses. See
[`docs/adr/0014`](docs/adr/0014-test-infrastructure-and-driver-parity.md).

### Developing against local Redis

Optional for the app itself — concurrency admission and daily spend caps use Redis
([`docs/adr/0035`](docs/adr/0035-redis-as-a-non-authoritative-tier.md)), but `npm run dev`
runs without it, falling back to Postgres-only rate limiting with no caps beyond that. The
production client (`@upstash/redis`) speaks Upstash's HTTP REST protocol, not the Redis wire
protocol, so a local `redis-server` needs the same kind of protocol proxy the Neon HTTP proxy
gives Postgres above:

```bash
docker network create fabula-net    # only needed once
docker run -d --name fabula-redis --network fabula-net redis:8-alpine
docker run -d --name fabula-srh --network fabula-net -p 8079:80 \
  -e SRH_MODE=env -e SRH_TOKEN=dev -e SRH_CONNECTION_STRING=redis://fabula-redis:6379 \
  hiett/serverless-redis-http:latest

KV_REST_API_URL="http://localhost:8079" KV_REST_API_TOKEN="dev" npm run dev
```

Required, not optional, for two things: `src/lib/ratelimit/store.parity.db.test.ts` and
`src/lib/admission/lease.db.test.ts` (they fail loudly with setup instructions if
`KV_REST_API_URL` isn't set, rather than silently skipping), and `npm run test:e2e`
(`admission-control.spec.ts` needs a real Redis to exercise concurrency refusal at all —
`e2e/global-setup.ts` checks reachability up front, same treatment as the Postgres/Neon-proxy
checks above, and fails with the same docker commands if it can't connect).

### Observability locally

Traces export over standard OTLP env vars — no code change to point at a
different backend, and unset means instrumentation is a no-op. To see a real
trace locally:

```bash
docker run -d --name fabula-jaeger -p 16686:16686 -p 4318:4318 \
  jaegertracing/all-in-one:latest
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
# then write a paragraph and open http://localhost:16686
```

A `fabula.generate` span should appear per generation, with provider/model,
token counts, TTFT, total duration, and estimated cost as attributes — never
prose, a theme, a character list, an email, or an IP (see
[`docs/adr/0022`](docs/adr/0022-observability-and-cost-accounting.md)).
`GET /api/health` reports app, database, and provider-key-configuration
status, and is unauthenticated by design so it still works if auth is broken.

## Project layout

See [`docs/architecture.md`](docs/architecture.md#directory-layout) for the full annotated tree. Broad strokes:

```
src/
  app/                 # Routes (App Router) — story canvas, library, feed, auth pages, API routes
  lib/providers/        # LLMProvider interface + per-provider adapters (the only thing route
                         # handlers/components ever call for AI generation)
  lib/story/             # Client story state (StoryContext), shared server-side validation
  lib/db/                  # Drizzle schema, client, migrations
  auth.ts, proxy.ts          # Auth.js config, route protection, nonce-based CSP + security headers
  lib/security/                # CSP policy string builder (src/proxy.ts is the only caller)
docs/                         # PRD, use cases, architecture, ADRs
```
