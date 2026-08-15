# Fabula — Architecture

This is a system-level overview of how Fabula is put together. For product scope and behavior, see `docs/PRD.md` and `docs/use-cases.md`. For the reasoning behind specific technical choices below, see the linked records in `docs/adr/` — this document describes *what exists*; the ADRs explain *why*.

## Stack

Next.js 16.3.0 (App Router), TypeScript (`strict: true`), Tailwind CSS v4, React 19. Client story state for an actively-written story lives in a React Context, not a database — see `docs/adr/0007-client-state-architecture.md`. As of v2, logged-in Writers additionally get server persistence: Postgres (Neon) via Drizzle, Auth.js v5 for sign-in — see `docs/adr/0009-accounts-and-persistence-architecture.md` and `docs/adr/0010-shared-story-feed-and-safety.md`. Guest (logged-out) use of the core write flow is unaffected and needs neither.

## Directory layout

```
src/
  app/
    layout.tsx           # Root layout — server-fetches session + provider list, mounts Providers
    providers.tsx          # "use client" — SessionProvider + StoryProvider
    page.tsx                 # Start screen (client component)
    story/page.tsx             # Story canvas (client component); hydrates from ?storyId= if present
    library/page.tsx             # Server Component — logged-in Writer's saved stories
    feed/page.tsx                  # Client component — paginated browsable feed of shared stories
    feed/[id]/page.tsx               # Server Component — read-only view of one shared story
    login/page.tsx, signup/page.tsx    # Auth forms
    api/generate/route.ts                # POST — the only caller of the provider registry; persists
                                          #   paragraphs write-through when storyId is present
    api/stories/route.ts                   # POST create / GET list (owner-scoped)
    api/stories/[id]/route.ts                # GET (hydrate) / PATCH (isShared, targetLength)
    api/stories/[id]/report/route.ts           # POST — report a shared story
    api/feed/route.ts                            # GET — paginated shared-story listing
    api/feed/[id]/route.ts                          # GET — one shared story, read-only
    api/auth/[...nextauth]/route.ts                   # Auth.js handlers
    api/auth/register/route.ts                          # Email/password signup (hashes + inserts user)
  lib/
    providers/
      types.ts             # LLMProvider interface, GenerateParagraphInput, StoryParagraph, InventedMetadata
      constants.ts           # MAX_OUTPUT_TOKENS, CONTEXT_WINDOW_CHAR_BUDGET
      prompt.ts               # Shared system prompt, message building, context windowing, metadata parsing
      anthropic.ts             # Claude adapter
      openai.ts                # GPT adapter
      openrouter.ts             # Llama (via OpenRouter) adapter
      registry.ts               # id -> LLMProvider lookup (server-only)
      list.ts                    # getProviderList() — the one place the registry is read for UI purposes
    story/
      types.ts               # Client-side story/generation state shapes (incl. storyId)
      turn.ts                  # isAIsTurn / isWritersTurn (mirrors the API route's turn check)
      streamGeneration.ts        # fetch + stream-parsing + sentinel-extraction
      StoryContext.tsx             # useReducer-based StoryProvider + useStory() hook; ensureStoryId()
    db/
      schema.ts               # Drizzle schema — Auth.js adapter tables + stories/storyParagraphs/storyReports
      client.ts                 # Lazy Drizzle/Neon singleton (mirrors the provider-client lazy-init pattern)
  auth.ts                    # Auth.js v5 config — providers, JWT session strategy, callbacks
  proxy.ts                     # Redirects unauthenticated requests away from /library, /feed
  components/
    AppHeader.tsx               # Session-aware nav (sign in/up, or library/feed/sign out)
    ShareToggle.tsx               # PATCH isShared from /library
    ReportButton.tsx                # POST report from /feed/[id]
docs/
  PRD.md, use-cases.md        # Product source of truth
  architecture.md              # This file
  adr/                           # Architecture Decision Records
```

## Request lifecycle: generating a paragraph

This is the path from a Writer clicking "Continue" (or "Get me started") to a new paragraph appearing on screen:

1. **Client state** (`StoryContext.tsx`): `generateNext()` reads the current `theme`/`characters`/`openingLines`/`selectedProviderId`/`paragraphs` from the reducer's state, dispatches `GENERATION_START` (so the UI shows a streaming placeholder), and calls `streamGeneration(...)`.
2. **`streamGeneration`** (`src/lib/story/streamGeneration.ts`) POSTs the request body to `/api/generate` and reads the response body as a stream, calling `onChunk(textSoFar)` as prose arrives. See `docs/adr/0003-streaming-wire-protocol.md` for how it separates prose from a possible trailing metadata sentinel.
3. **The route handler** (`src/app/api/generate/route.ts`) validates the request body against the shared guards in `src/lib/story/validation.ts` (paragraph shape, hint lengths, `targetLength` bounds — see the input trust boundary below), checks turn legality (`docs/adr/0004-strict-turn-taking-policy.md`), looks up the requested provider via `getProvider(id)` from the registry, and calls `provider.generateParagraph(...)`. It pre-fetches the first chunk before opening the response stream so a provider failure surfaces as a clean `502` rather than a broken `200` (`docs/adr/0003-streaming-wire-protocol.md`). For logged-in Writers with `storyId`, it now uses `syncStoryParagraphs()` to reconcile client and server state atomically, preventing the TOCTOU race condition documented in `docs/adr/0013-concurrency-safe-paragraph-positioning.md`.
4. **The provider adapter** (e.g. `anthropic.ts`) builds the actual request: `prompt.ts`'s `buildSystemPrompt()` (safety default, style constraints — `docs/adr/0006-content-safety-defaults.md`) and `buildMessages()` (story history converted to chat messages, after `windowStoryParagraphs()` compacts it — `docs/adr/0005-context-window-management.md`), then calls the provider's SDK with streaming enabled and yields text chunks as they arrive.
5. **Back at the route handler**, each yielded chunk is enqueued onto the `Response`'s `ReadableStream`. Once the adapter's generator finishes, its return value (`InventedMetadata | undefined` — see `docs/adr/0001-model-agnostic-provider-interface.md`) is appended as a trailing sentinel if present, and the stream closes.
6. **Back in `streamGeneration`**, once the stream ends, any parsed metadata is passed to `onDone(finalText, metadata)`.
7. **Back in `StoryContext.tsx`**, `onDone` dispatches `GENERATION_DONE`, which appends the finished paragraph (tagged with which `providerId` generated it) to `paragraphs` and, if present, stores the invented metadata for the story-canvas header tag to display.

A failure at any point (`onError`) dispatches `GENERATION_ERROR`, which the story canvas renders as a banner — except a mid-stream failure on the first attempt, which triggers one silent automatic retry before showing anything to the Writer (`docs/adr/0007-client-state-architecture.md` and the story canvas's error-handling logic).

## Provider abstraction

See `docs/adr/0001-model-agnostic-provider-interface.md` for the full rationale. In short: `src/lib/providers/registry.ts` is the single source of truth mapping a provider id to its `LLMProvider` implementation, and nothing outside `src/lib/providers/` ever imports a provider SDK directly.

## Client/server boundary

`src/lib/providers/registry.ts` (and everything it imports) is server-only — it reads secret API keys from environment variables and initializes provider SDK clients. It's read for UI purposes in exactly one place, `src/app/layout.tsx` (a Server Component), via `src/lib/providers/list.ts`. See `docs/adr/0007-client-state-architecture.md` for why this specific plumbing was chosen and how it's verified not to leak into the client bundle.

## Persistence & auth

See `docs/adr/0009-accounts-and-persistence-architecture.md` for full rationale; this is the shape of it.

- **Stack**: Postgres via a managed Neon project, `drizzle-orm`'s Neon HTTP driver (`src/lib/db/client.ts`, lazily initialized so a missing `DATABASE_URL` doesn't break `next build`/`next dev` before a database is provisioned — mirrors the lazy provider-client pattern in `src/lib/providers/anthropic.ts`). Auth.js v5 (`src/auth.ts`) handles sign-in: `Credentials` (email/password, hashed with `bcryptjs`) and `Google`, both backed by `@auth/drizzle-adapter` for user/account storage, with **JWT sessions** — not the database session strategy the adapter defaults toward, because Auth.js only writes adapter `sessions` rows for OAuth sign-ins; a database-session strategy would silently break Credentials logins.
- **Write-through mirror, not a second source of truth**: `StoryContext` (client) remains authoritative while a story is actively being written, exactly as `docs/adr/0007-client-state-architecture.md` describes — this didn't change. For a logged-in Writer, `ensureStoryId()` lazily creates a `stories` row (via `POST /api/stories`) on that Writer's first turn, and every subsequent `/api/generate` call includes the resulting `storyId`. The route handler then persists any paragraphs in `storySoFar` not yet in the database (using content-based reconciliation via `syncStoryParagraphs()` to safely handle concurrent requests, fixing the TOCTOU race condition — see `docs/adr/0013-concurrency-safe-paragraph-positioning.md`) before generating, and persists the AI's paragraph after its stream completes. Guests, and logged-in Writers who haven't triggered `ensureStoryId()` yet, skip persistence entirely with no behavior change from v1.
- **Session/route boundary**: `src/proxy.ts` (Next 16's `middleware` convention, renamed) redirects unauthenticated requests away from `/library` and `/feed` to `/login`. Individual API routes under `api/stories/`, `api/feed/`, and `api/generate` (when a `storyId` is present) additionally self-check `auth()` — defense in depth, since proxy/middleware alone is not a substitute for per-route authorization per Next.js's own guidance.
- **Client/server session boundary**: `src/app/layout.tsx` stays a Server Component; it calls `await auth()` once and passes the session into `src/app/providers.tsx` (`"use client"`), which wraps `next-auth/react`'s `SessionProvider` around the existing `StoryProvider`. `AppHeader.tsx` and any other client component read session state via `useSession()`, never by importing `src/auth.ts` (server-only) directly.
- **Input trust boundary**: nothing a client sends is trusted for shape or range. `src/lib/story/validation.ts` holds the shared guards every story-accepting route composes into its own `isValidBody` — paragraph element shape (`storySoFar` is written straight into `story_paragraph` and the provider prompt), hint length caps, and `targetLength` bounded to the same range the UI's slider enforces. Those bounds live in `src/lib/story/constants.ts` rather than `StoryContext.tsx` specifically so route handlers can import the actual numbers: under RSC, a `"use client"` module's exports become client references when imported server-side, which would fail silently rather than at build time. Separately, `src/lib/auth/callbackUrl.ts` is the only sanctioned way to consume a `callbackUrl` — it resolves the untrusted value against the real origin instead of pattern-matching the string, because a prefix check is defeated by browser backslash normalization. See `docs/adr/0011-security-hardening-post-review.md`.
- **Sharing**: `stories.isShared` (boolean, default false) gates visibility in `/feed` and `/api/feed`; toggled via `PATCH /api/stories/:id`. A shared story is readable read-only at `/feed/[id]` by any logged-in Writer, with a `storyReports` table (unique per `storyId`+`reporterId`) backing a non-blocking "Report" action. See `docs/adr/0010-shared-story-feed-and-safety.md` for the logged-in-only-feed rationale and the explicit non-goals (no moderation queue, no comments/likes/follows).
