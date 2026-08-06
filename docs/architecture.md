# Fabula — Architecture

This is a system-level overview of how Fabula is put together. For product scope and behavior, see `docs/PRD.md` and `docs/use-cases.md`. For the reasoning behind specific technical choices below, see the linked records in `docs/adr/` — this document describes *what exists*; the ADRs explain *why*.

## Stack

Next.js 16.3.0 (App Router), TypeScript (`strict: true`), Tailwind CSS v4, React 19. No database, no auth, no server-persisted state — see `docs/adr/0007-client-state-architecture.md`.

## Directory layout

```
src/
  app/
    layout.tsx           # Root layout — mounts StoryProvider (server-side provider list fetch)
    page.tsx              # Start screen (client component)
    story/page.tsx          # Story canvas (client component)
    api/generate/route.ts    # POST endpoint — the only caller of the provider registry
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
      types.ts               # Client-side story/generation state shapes
      turn.ts                  # isAIsTurn / isWritersTurn (mirrors the API route's turn check)
      streamGeneration.ts        # fetch + stream-parsing + sentinel-extraction
      StoryContext.tsx             # useReducer-based StoryProvider + useStory() hook
docs/
  PRD.md, use-cases.md        # Product source of truth
  architecture.md              # This file
  adr/                           # Architecture Decision Records
```

## Request lifecycle: generating a paragraph

This is the path from a Writer clicking "Continue" (or "Get me started") to a new paragraph appearing on screen:

1. **Client state** (`StoryContext.tsx`): `generateNext()` reads the current `theme`/`characters`/`openingLines`/`selectedProviderId`/`paragraphs` from the reducer's state, dispatches `GENERATION_START` (so the UI shows a streaming placeholder), and calls `streamGeneration(...)`.
2. **`streamGeneration`** (`src/lib/story/streamGeneration.ts`) POSTs the request body to `/api/generate` and reads the response body as a stream, calling `onChunk(textSoFar)` as prose arrives. See `docs/adr/0003-streaming-wire-protocol.md` for how it separates prose from a possible trailing metadata sentinel.
3. **The route handler** (`src/app/api/generate/route.ts`) validates the request body, checks turn legality (`docs/adr/0004-strict-turn-taking-policy.md`), looks up the requested provider via `getProvider(id)` from the registry, and calls `provider.generateParagraph(...)`. It pre-fetches the first chunk before opening the response stream so a provider failure surfaces as a clean `502` rather than a broken `200` (`docs/adr/0003-streaming-wire-protocol.md`).
4. **The provider adapter** (e.g. `anthropic.ts`) builds the actual request: `prompt.ts`'s `buildSystemPrompt()` (safety default, style constraints — `docs/adr/0006-content-safety-defaults.md`) and `buildMessages()` (story history converted to chat messages, after `windowStoryParagraphs()` compacts it — `docs/adr/0005-context-window-management.md`), then calls the provider's SDK with streaming enabled and yields text chunks as they arrive.
5. **Back at the route handler**, each yielded chunk is enqueued onto the `Response`'s `ReadableStream`. Once the adapter's generator finishes, its return value (`InventedMetadata | undefined` — see `docs/adr/0001-model-agnostic-provider-interface.md`) is appended as a trailing sentinel if present, and the stream closes.
6. **Back in `streamGeneration`**, once the stream ends, any parsed metadata is passed to `onDone(finalText, metadata)`.
7. **Back in `StoryContext.tsx`**, `onDone` dispatches `GENERATION_DONE`, which appends the finished paragraph (tagged with which `providerId` generated it) to `paragraphs` and, if present, stores the invented metadata for the story-canvas header tag to display.

A failure at any point (`onError`) dispatches `GENERATION_ERROR`, which the story canvas renders as a banner — except a mid-stream failure on the first attempt, which triggers one silent automatic retry before showing anything to the Writer (`docs/adr/0007-client-state-architecture.md` and the story canvas's error-handling logic).

## Provider abstraction

See `docs/adr/0001-model-agnostic-provider-interface.md` for the full rationale. In short: `src/lib/providers/registry.ts` is the single source of truth mapping a provider id to its `LLMProvider` implementation, and nothing outside `src/lib/providers/` ever imports a provider SDK directly.

## Client/server boundary

`src/lib/providers/registry.ts` (and everything it imports) is server-only — it reads secret API keys from environment variables and initializes provider SDK clients. It's read for UI purposes in exactly one place, `src/app/layout.tsx` (a Server Component), via `src/lib/providers/list.ts`. See `docs/adr/0007-client-state-architecture.md` for why this specific plumbing was chosen and how it's verified not to leak into the client bundle.
