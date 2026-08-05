<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Fabula — Project Rules

These rules govern all agent work in this repo. They apply on top of, and never override, the Next.js block above.

## Source of truth

Before implementing any feature, read `docs/PRD.md` and `docs/use-cases.md`. If a task isn't covered by either, stop and ask rather than inventing scope.

## Stack constraints

- Next.js **16.3.0**, App Router, TypeScript, Tailwind. Do not add pages router, do not add a separate CSS framework.
- No database, no auth, no server-persisted user data in v1 (see PRD non-goals). Story state lives in client/session memory only.
- Do not introduce a new package (state management, UI kit, etc.) without checking if the existing stack already covers it.

## Responsive design (required, not optional)

Both personas (see PRD) plausibly use Fabula on a phone or tablet, not just desktop — a parent and kid co-writing are as likely to be on a shared tablet as a laptop. Every screen must work at mobile, tablet, and desktop widths.

- Use Tailwind responsive utilities (`sm:`/`md:`/`lg:` etc.) — no fixed pixel widths that break below desktop, no horizontal scrolling at any breakpoint.
- Tap targets (buttons, provider picker, chips) must stay usable at mobile widths, not just shrink.
- Before considering any UI-touching task done, check the layout at a mobile width (e.g. ~375px) in addition to desktop — don't only eyeball desktop and assume it reflows correctly.

## LLM provider architecture (core constraint)

The app must remain model-agnostic. All provider calls go through a single interface — do not call a provider SDK directly from route handlers or components.

```ts
// src/lib/providers/types.ts
interface LLMProvider {
  id: string // 'anthropic' | 'openai' | 'openrouter' | ...
  displayName: string
  // AsyncGenerator<string, ...> is a strict superset of AsyncIterable<string> — for-await-of
  // consumers see no difference. The return value carries the AI's invented theme/characters
  // (UC-3's "separate tag" requirement) for the one consumer (the API route) that drives the
  // generator manually via .next() instead of for-await-of.
  generateParagraph(
    input: GenerateParagraphInput
  ): AsyncGenerator<string, InventedMetadata | undefined, unknown> // streamed chunks
}
```

- Each provider (Anthropic, OpenAI, one open-weight model via OpenRouter/Together) implements this interface in its own file under `src/lib/providers/`.
- Adding a new provider must never require changing calling code, only adding a new implementation + registry entry.
- Streaming is required, not optional — UI must show text as it arrives.

## Content safety

Fabula's audience includes parents co-writing with kids (see PRD personas). AI-generated story content must default to broadly age-appropriate output unless a Writer explicitly signals otherwise. Do not build a toggle for this in v1 — it's a default prompting/system-prompt concern, not a feature.

## Agent working agreement

- Follow `docs/use-cases.md` for exact flows (including the US-6 resolution: theme/characters/lines are always optional, never gate the human "I'll write" path).
- Don't add authentication, sign-in, or persistence scaffolding even if it seems like natural next work — that's explicitly v2, tracked in the PRD non-goals.
- Keep changes scoped to the requested feature. If implementing one use case surfaces a gap in the spec, flag it back rather than improvising a resolution.
- Run `next dev` / `next build` and fix resulting errors before considering a task done.
