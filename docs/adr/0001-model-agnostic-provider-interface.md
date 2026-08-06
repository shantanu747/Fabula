# 1. Model-agnostic provider interface

## Status

Accepted.

## Context

Fabula lets a Writer generate story paragraphs using any of several LLM providers (Anthropic, OpenAI, and an open-weight model via an aggregator), and switch between them mid-story. Calling each provider's SDK directly from route handlers or UI code would mean three different request/response shapes, three different streaming APIs, and duplicated prompt-construction logic leaking into application code — and adding a fourth provider later would mean hunting down every call site.

## Decision

All provider calls go through a single interface, defined once in `src/lib/providers/types.ts`:

```ts
export interface LLMProvider {
  id: string;
  displayName: string;
  generateParagraph(
    input: GenerateParagraphInput
  ): AsyncGenerator<string, InventedMetadata | undefined, unknown>;
}
```

Each provider (`src/lib/providers/anthropic.ts`, `openai.ts`, `openrouter.ts`) implements this interface independently — SDK-specific streaming logic stays inside its own file, never leaking into `src/app/api/generate/route.ts` or any component. A registry (`src/lib/providers/registry.ts`) maps `id -> LLMProvider`; the route handler only ever calls `getProvider(id)` and `.generateParagraph(...)`. Adding a fifth provider means adding one new file and one new registry entry — no existing call site changes.

Shared logic that would otherwise be duplicated three times — the system prompt, the age-appropriateness default, converting story history into chat messages, the context-window truncation — lives once in `src/lib/providers/prompt.ts` and is imported by all three adapters.

### The `AsyncGenerator<string, InventedMetadata | undefined>` return type

The interface's return type is a deliberate superset of a plainer `AsyncIterable<string>`. UC-3 (a Writer starts a story with zero input) requires the AI to invent a genre/characters/opening *and* have that shown to the Writer as a separate header tag above the story canvas — not just embedded in the prose. A pure text stream has no channel for that.

Rather than adding a second method to the interface, or a discriminated stream of `{type: "text"|"metadata", ...}` chunks (which would force every consumer to branch on chunk type even when metadata never applies), the interface uses a generator's own return value: `async function* generateParagraph()` can `yield` prose chunks throughout and `return` a final `InventedMetadata | undefined` value once. A plain `for await...of` consumer — the common case — sees no difference from a bare `AsyncIterable<string>`, since a generator's return value isn't visible to `for await...of` at all. Only a consumer that manually drives the iterator via `.next()` — which `src/app/api/generate/route.ts` already does, for an unrelated reason (see [ADR 3](0003-streaming-wire-protocol.md)) — can read it.

`InventedMetadata` (`{theme?: string, characters?: string}`) is only ever populated on the true "zero input" kickoff case; every other call returns `undefined`, at zero extra cost to callers that don't care about it.

## Consequences

- The three adapter files are the only places that import `@anthropic-ai/sdk` or `openai`. Nothing else in the codebase — including client-rendered UI — can accidentally depend on a provider SDK.
- The registry and shared prompt-building logic are the single source of truth for provider ids and display names; see [ADR 7](0007-client-state-architecture.md) for how that's threaded through to the UI without leaking server-only code into client bundles.
- The generator-return-value trick is a slightly unusual pattern; it's documented inline at the interface definition specifically so a future reader doesn't mistake it for a plain string stream.
