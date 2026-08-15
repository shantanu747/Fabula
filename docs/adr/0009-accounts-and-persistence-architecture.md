# 9. Accounts and persistence architecture

## Status

Accepted.

## Context

`docs/PRD.md` §3 named accounts, a persisted story library, and sharing as the confirmed v2 direction. Before this, Fabula had no database and no auth (`docs/adr/0007-client-state-architecture.md`). Introducing both requires deliberate justification per `AGENTS.md`'s stack constraints.

Product-level questions about hosting, auth methods, and sharing were resolved with the Writer beforehand. This record covers the engineering decisions: ORM choice, auth library, and how server persistence coexists with the existing client-authoritative state model.

## Decision

**Database & ORM**: Managed Neon Postgres accessed via `drizzle-orm`'s Neon HTTP driver (`src/lib/db/client.ts`). We chose Drizzle over Prisma for its lack of a codegen daemon, plain TypeScript schema, and natural fit for Neon's HTTP driver in serverless functions.

The client constructs lazily behind `getDb()` to mirror the pattern in `src/lib/providers/anthropic.ts`. This ensures a missing `DATABASE_URL` fails at first use, not at module load, avoiding breakage of `next build`/`next dev`.

**Auth**: Auth.js v5 with `@auth/drizzle-adapter`, a `Credentials` provider (email/password hashed with `bcryptjs`) and Google provider. **Session strategy uses JWT**, not database sessions. Auth.js's adapter only persists session rows for OAuth sign-ins — a `Credentials` provider's successful `authorize()` never gets a DB session written. Using database sessions would silently break email/password login, making JWT sessions the safer default.

The adapter still handles `users`/`accounts`/`sessions` persistence with JWT sessions — only the session storage mechanism differs.

**Schema** (`src/lib/db/schema.ts`): `users`/`accounts`/`sessions`/`verificationTokens` follow `@auth/drizzle-adapter`'s required Postgres shape exactly. We extend `users` with a nullable `passwordHash` for Credentials sign-ins (null for Google-only accounts).

App-specific tables (`stories`, `storyParagraphs`, `storyReports`) mirror the client-side `StoryState`/`StoryParagraph` shapes in `src/lib/story/types.ts` for easier reasoning.

**Persistence model**: write-through mirror with client remaining source of truth. While a story is actively being written, `StoryContext` remains authoritative. For signed-in writers, `ensureStoryId()` lazily creates a `stories` row on the first turn, and subsequent `/api/generate` calls carry the resulting `storyId`.

The route handler persists any paragraphs in `storySoFar` not yet in the database — computed as a diff against stored paragraph count. This prevents double-writes or dropped paragraphs from client bugs or retries. No new per-turn network requests are added: persistence rides along on the existing `/api/generate` call.

**Implicit guest-story adoption**: Instead of a dedicated "adopt this story" flow, we use the existing diff-based persistence. A guest's entire pre-login paragraph backlog gets persisted in one shot when `ensureStoryId()` fires on their first post-login turn.

**Defense in depth**: `src/proxy.ts` redirects unauthenticated requests from `/library` and `/feed`. Every route handler that touches story data independently re-checks `auth()` and verifies row ownership, not trusting the proxy layer alone.

## Consequences

- Guest use of the core write flow (`/`, `/story` without a `storyId`) remains unchanged — no new network calls or failure modes.
- Writers switching accounts or signing out mid-story don't retroactively unpersist existing content. The `storyId` in client state stops being reusable when ownership no longer matches.
- JWT sessions mean specific session revocation isn't possible without additional plumbing. This is an accepted tradeoff given the Credentials-provider constraint.
- The schema mirroring client shapes makes persistence code nearly mechanical translations, but client-side changes will need matching migrations.
- Migration tooling uses `drizzle-kit generate`/`migrate` as intended, but should be verified against a live database when available.
