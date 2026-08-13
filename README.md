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
npm run lint     # ESLint
npm run build    # production build
npm test         # unit tests (vitest)
```

## Project layout

See [`docs/architecture.md`](docs/architecture.md#directory-layout) for the full annotated tree. Broad strokes:

```
src/
  app/                 # Routes (App Router) — story canvas, library, feed, auth pages, API routes
  lib/providers/        # LLMProvider interface + per-provider adapters (the only thing route
                         # handlers/components ever call for AI generation)
  lib/story/             # Client story state (StoryContext), shared server-side validation
  lib/db/                  # Drizzle schema, client, migrations
  auth.ts, proxy.ts          # Auth.js config, route protection
docs/                         # PRD, use cases, architecture, ADRs
```
