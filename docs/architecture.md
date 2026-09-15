# Fabula — Architecture

This is a system-level overview of how Fabula is put together. For product scope and behavior, see `docs/PRD.md` and `docs/use-cases.md`. For the reasoning behind specific technical choices below, see the linked records in `docs/adr/` — this document describes *what exists*; the ADRs explain *why*.

## Stack

Next.js 16.3.4 (App Router), TypeScript (`strict: true`), Tailwind CSS v4, React 19. Client story state for an actively-written story lives in a React Context, not a database — see `docs/adr/0007-client-state-architecture.md`. As of v2, logged-in Writers additionally get server persistence: Postgres (Neon) via Drizzle, Auth.js v5 for sign-in — see `docs/adr/0009-accounts-and-persistence-architecture.md` and `docs/adr/0010-shared-story-feed-and-safety.md`. Guest (logged-out) use of the core write flow is unaffected and needs neither.

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
    forgot/page.tsx, reset/page.tsx      # Password reset request + completion (docs/adr/0046)
    verify/page.tsx                        # Verification link landing page; refreshes the session via update()
    api/generate/route.ts                    # POST — the only caller of the provider registry; persists
                                              #   paragraphs write-through when storyId is present
    api/generate/[requestId]/resume/route.ts  # GET — replays/tails a dropped generation (docs/adr/0043)
    api/stories/route.ts                   # POST create / GET list (owner-scoped)
    api/stories/[id]/route.ts                # GET (hydrate) / PATCH (isShared, targetLength; isShared:true gated on verification)
    api/stories/[id]/paragraphs/route.ts       # POST — persist-on-submit for the Writer's own turn
    api/stories/[id]/report/route.ts           # POST — report a shared story
    api/feed/route.ts                            # GET — paginated shared-story listing
    api/feed/[id]/route.ts                          # GET — one shared story, read-only
    api/auth/[...nextauth]/route.ts                   # Auth.js handlers
    api/auth/register/route.ts                          # Email/password signup (hashes + inserts user)
    api/auth/verify/request/route.ts, verify/[token]/route.ts  # Email verification (docs/adr/0046)
    api/auth/password/request/route.ts, password/reset/route.ts  # Password reset (docs/adr/0046, 0047)
    api/cron/prune/route.ts                               # CRON_SECRET-guarded rate_limit_bucket pruning
  lib/
    streaming/
      protocol.ts              # Framed SSE event types, encoder, incremental parser (docs/adr/0042)
      resumeBuffer.ts            # Redis-backed accumulated-events buffer behind resume (docs/adr/0043)
    kv/
      client.ts                # getKv()/hasKv() — lazy Redis singleton, mirrors db/client.ts (docs/adr/0035)
    admission/
      lease.ts                 # Per-identity + global concurrency leases (docs/adr/0036)
    budget/
      index.ts                 # Daily spend caps, reconciled from generation_event (docs/adr/0036)
    ratelimit/
      policy.ts, store.ts, guard.ts  # Token-bucket rate limiting — Postgres (docs/adr/0015) + Redis (docs/adr/0035)
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
      streamGeneration.ts        # fetch + framed-SSE parsing + resume-on-transport-failure
      StoryContext.tsx             # useReducer-based StoryProvider + useStory() hook; ensureStoryId()
    db/
      schema.ts               # Drizzle schema — Auth.js adapter tables + stories/storyParagraphs/storyReports
      client.ts                 # Lazy Drizzle/Neon singleton (mirrors the provider-client lazy-init pattern)
    security/
      csp.ts                    # buildCsp() — pure CSP-string builder; src/proxy.ts is the only caller
      assertSameOrigin.ts        # CSRF guard for every mutating route (docs/adr/0048)
    http/
      readJsonBody.ts           # Body-size-bounded JSON parsing, shared by every mutating route
    auth/
      authorize.ts              # Credentials provider's authorize(), extracted for testability
      googleAutoVerify.ts         # Pure predicate: should this Google sign-in be marked verified
      tokenVersion.ts            # Session revocation — Redis-cached, Postgres source of truth (docs/adr/0047)
      verificationTokens.ts        # Email verification token issuance/consumption (hashed, single-use)
      passwordResetTokens.ts         # Password reset token issuance/consumption (hashed, single-use)
      errors.ts                        # TooManyAttemptsError — the one CredentialsSignin subclass this app defines
    email/
      types.ts, registry.ts       # Mailer interface + env-selected registry (mirrors providers/registry.ts)
      console.ts, resend.ts         # ConsoleMailer (default, keyless) and ResendMailer (via fetch, no SDK)
      templates.ts                    # Verification/reset email subject+html+text
  auth.ts                    # Auth.js v5 config — providers, JWT session strategy, callbacks
  proxy.ts                     # Redirects unauthenticated requests away from /library, /feed; attaches a
                                #   nonce-based CSP + security headers to every page response
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
2. **`streamGeneration`** (`src/lib/story/streamGeneration.ts`) POSTs the request body to `/api/generate` and reads the response body as a framed Server-Sent Events stream (`src/lib/streaming/protocol.ts`), calling `onChunk(textSoFar)` as `chunk` events arrive. See `docs/adr/0042-framed-streaming-protocol.md` (superseding the original sentinel-based wire format) for the event types and why SSE.
3. **The route handler** (`src/app/api/generate/route.ts`) validates the request body against the shared guards in `src/lib/story/validation.ts` (paragraph shape, hint lengths, `targetLength` bounds — see the input trust boundary below), checks turn legality (`docs/adr/0004-strict-turn-taking-policy.md`), looks up the requested provider via `getProvider(id)` from the registry, checks `src/lib/providers/circuitBreaker.ts` (Redis-backed, fails open without Redis — `docs/adr/0045-provider-circuit-breaker.md`) and, if open, returns the same `provider-unavailable` `502` a real failure would without ever calling the provider, and otherwise calls `provider.generateParagraph(...)`. It pre-fetches the first chunk before opening the response stream so a provider failure surfaces as a clean `502` rather than a broken `200` (still true under the framed protocol — `docs/adr/0042`). For logged-in Writers with `storyId`, it now uses `syncStoryParagraphs()` to reconcile client and server state atomically, preventing the TOCTOU race condition documented in `docs/adr/0013-concurrency-safe-paragraph-positioning.md`.
4. **The provider adapter** (e.g. `anthropic.ts`) builds the actual request: `prompt.ts`'s `buildSystemPrompt()` (safety default, style constraints — `docs/adr/0006-content-safety-defaults.md`) and `buildMessages()` (story history converted to chat messages, after `windowStoryParagraphs()` compacts it — `docs/adr/0005-context-window-management.md`), then calls the provider's SDK with streaming enabled and yields text chunks as they arrive.
5. **Back at the route handler**, each yielded chunk is emitted as a `chunk` event on the `Response`'s `ReadableStream`, and — when Redis is configured — mirrored into a resume buffer keyed by this request's id (`src/lib/streaming/resumeBuffer.ts`, `docs/adr/0043-resumable-generation.md`). A client that disconnects mid-stream gets a bounded grace window before the provider call is actually aborted, so a generation that finishes moments after a dropped connection isn't lost. Once the adapter's generator finishes, its return value (`InventedMetadata | undefined` — see `docs/adr/0001-model-agnostic-provider-interface.md`) becomes a `meta` event, token usage becomes a `usage` event, and a terminal `done` event (carrying whether the paragraph was actually persisted) closes the stream normally. A mid-stream provider failure or idle stall is likewise a typed `error` event on a normally-closed stream, not an abnormal termination.
6. **Back in `streamGeneration`**, once the stream ends, any parsed metadata and the `done` frame's `persisted` flag are passed to `onDone(finalText, metadata, persisted)`. A stream that breaks for transport reasons (not a clean `error`/`done` frame) attempts one resume against `GET /api/generate/[requestId]/resume` before falling back to the pre-existing generic error.
7. **Back in `StoryContext.tsx`**, `onDone` dispatches `GENERATION_DONE`, which appends the finished paragraph (tagged with which `providerId` generated it) to `paragraphs` and, if present, stores the invented metadata for the story-canvas header tag to display. When this turn sent a `storyId`, it also dispatches `SET_SAVE_STATE` from `persisted`, so the canvas's save indicator reflects the AI paragraph's own mirror-write outcome, not just the Writer's (`docs/adr/0044-durable-writer-turns-and-idempotent-creation.md`).

A failure at any point (`onError`) dispatches `GENERATION_ERROR`, which the story canvas renders as a banner — except a mid-stream failure on the first attempt, which triggers one silent automatic retry before showing anything to the Writer (`docs/adr/0007-client-state-architecture.md` and the story canvas's error-handling logic), and except a `kind: "network"` failure (the request never reached the server at all), which backs off and retries silently up to a bounded attempt count (`src/lib/story/retry.ts`) before falling back to the same banner.

## Provider abstraction

See `docs/adr/0001-model-agnostic-provider-interface.md` for the full rationale. In short: `src/lib/providers/registry.ts` is the single source of truth mapping a provider id to its `LLMProvider` implementation, and nothing outside `src/lib/providers/` ever imports a provider SDK directly.

## Client/server boundary

`src/lib/providers/registry.ts` (and everything it imports) is server-only — it reads secret API keys from environment variables and initializes provider SDK clients. It's read for UI purposes in exactly one place, `src/app/layout.tsx` (a Server Component), via `src/lib/providers/list.ts`. See `docs/adr/0007-client-state-architecture.md` for why this specific plumbing was chosen and how it's verified not to leak into the client bundle.

## Persistence & auth

See `docs/adr/0009-accounts-and-persistence-architecture.md` for full rationale; this is the shape of it.

- **Stack**: Postgres via a managed Neon project, `drizzle-orm`'s Neon HTTP driver (`src/lib/db/client.ts`, lazily initialized so a missing `DATABASE_URL` doesn't break `next build`/`next dev` before a database is provisioned — mirrors the lazy provider-client pattern in `src/lib/providers/anthropic.ts`). Auth.js v5 (`src/auth.ts`) handles sign-in: `Credentials` (email/password, hashed with `bcryptjs`) and `Google`, both backed by `@auth/drizzle-adapter` for user/account storage, with **JWT sessions** — not the database session strategy the adapter defaults toward, because Auth.js only writes adapter `sessions` rows for OAuth sign-ins; a database-session strategy would silently break Credentials logins.
- **Write-through mirror, not a second source of truth**: `StoryContext` (client) remains authoritative while a story is actively being written, exactly as `docs/adr/0007-client-state-architecture.md` describes — this didn't change. For a logged-in Writer, `ensureStoryId()` lazily creates a `stories` row (via `POST /api/stories`, carrying an `Idempotency-Key` so a network-level retry can't create a second row — `docs/adr/0044-durable-writer-turns-and-idempotent-creation.md`) on that Writer's first turn, and every subsequent `/api/generate` call includes the resulting `storyId`. The route handler then persists any paragraphs in `storySoFar` not yet in the database (using content-based reconciliation via `syncStoryParagraphs()` to safely handle concurrent requests, fixing the TOCTOU race condition — see `docs/adr/0013-concurrency-safe-paragraph-positioning.md`) before generating, and persists the AI's paragraph after its stream completes. A Writer's own paragraph no longer waits for that next `/api/generate` call to become durable, either: `WRITER_SUBMIT` fires a dedicated `POST /api/stories/[id]/paragraphs` immediately, calling the same `syncStoryParagraphs()`, concurrently with (not blocking) the AI's turn starting. `StoryState.saveState` (`"unsaved" | "saving" | "saved" | "error"`) surfaces the outcome of either write — silent unsaved state was a named bug this closes. Guests, and logged-in Writers who haven't triggered `ensureStoryId()` yet, skip persistence entirely with no behavior change from v1.
- **Session/route boundary**: `src/proxy.ts` (Next 16's `middleware` convention, renamed) redirects unauthenticated requests away from `/library` and `/feed` to `/login`. Individual API routes under `api/stories/`, `api/feed/`, and `api/generate` (when a `storyId` is present) additionally self-check `auth()` — defense in depth, since proxy/middleware alone is not a substitute for per-route authorization per Next.js's own guidance. `proxy.ts` also runs on every non-API page route to attach a per-request nonce-based Content-Security-Policy and the static security headers (`next.config.ts` sets the rest, since those don't need a nonce) — see `docs/adr/0024-security-headers-and-supply-chain.md`.
- **Client/server session boundary**: `src/app/layout.tsx` stays a Server Component; it calls `await auth()` once and passes the session into `src/app/providers.tsx` (`"use client"`), which wraps `next-auth/react`'s `SessionProvider` around the existing `StoryProvider`. `AppHeader.tsx` and any other client component read session state via `useSession()`, never by importing `src/auth.ts` (server-only) directly.
- **Input trust boundary**: nothing a client sends is trusted for shape or range. `src/lib/story/validation.ts` holds the shared guards every story-accepting route composes into its own `isValidBody` — paragraph element shape (`storySoFar` is written straight into `story_paragraph` and the provider prompt), hint length caps, and `targetLength` bounded to the same range the UI's slider enforces. Those bounds live in `src/lib/story/constants.ts` rather than `StoryContext.tsx` specifically so route handlers can import the actual numbers: under RSC, a `"use client"` module's exports become client references when imported server-side, which would fail silently rather than at build time. Separately, `src/lib/auth/callbackUrl.ts` is the only sanctioned way to consume a `callbackUrl` — it resolves the untrusted value against the real origin instead of pattern-matching the string, because a prefix check is defeated by browser backslash normalization. See `docs/adr/0011-security-hardening-post-review.md`.
- **Sharing**: `stories.isShared` (boolean, default false) gates visibility in `/feed` and `/api/feed`; toggled via `PATCH /api/stories/:id`. A shared story is readable read-only at `/feed/[id]` by any logged-in Writer, with a `storyReports` table (unique per `storyId`+`reporterId`) backing a non-blocking "Report" action. See `docs/adr/0010-shared-story-feed-and-safety.md` for the logged-in-only-feed rationale and the explicit non-goals (no moderation queue, no comments/likes/follows). Sharing (not writing) additionally requires `users.emailVerified` — see the next bullet.
- **Account lifecycle** (`docs/adr/0046`, `0047`, `0048`): email verification and password reset both use single-use, hashed tokens (`verificationTokens`/`passwordResetTokens`), sent via `src/lib/email/`'s `Mailer` registry (`ConsoleMailer` by default — logs instead of sending, which is what CI/E2E run against). Verification gates only `PATCH /api/stories/[id]`'s `isShared: true` transition, never writing. `authorize()` (`src/lib/auth/authorize.ts`) is rate limited per-IP and per-account and compares against a dummy hash on every miss, the same timing-safety posture ADR 0011 gave registration. Session revocation (a password reset bumps `users.tokenVersion`) is checked only on mutating routes, never on a page render — `src/lib/auth/tokenVersion.ts`'s `assertSessionCurrent`, cached in Redis with Postgres underneath — deliberately preserving `auth()`'s zero-database-round-trip property on every render; the residual exposure (a revoked session's read access survives up to `session.maxAge`, 14 days) is accepted and stated plainly rather than closed with a more elaborate per-render mechanism.
- **CSRF**: every mutating route calls `assertSameOrigin` (`src/lib/security/`) before touching anything — `Origin` compared against the resolved request origin, rejecting a mismatch or an absent header. `src/lib/http/readJsonBody.ts` bounds every request body by size the same way, before it's ever parsed.

## Design system

`docs/design/` is the committed spec the redesign ADRs (0029–0033) cite: the handoff README (`docs/design/handoff.md`), the Classical design system's source stylesheet (`docs/design/classical/`), and reference screenshots of every board. The tokens it describes are implemented as CSS custom properties in `src/app/globals.css`, layered under Tailwind v4's `@theme`; components consume them as utility classes rather than reading the properties directly. `docs/design/screenshots/before/` keeps the two pre-redesign boards for comparison; nothing in `src/` references the old `mockups/` screens, which were deleted once the graph nodes extracted from them were no longer needed.
