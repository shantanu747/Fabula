# 6. Content safety defaults

## Status

Accepted.

## Context

One of Fabula's two named personas (`docs/PRD.md`) is a parent co-writing with a child as an activity. That persona can't be expected to pre-screen every AI-generated paragraph before a child reads it (US-7), which means the AI's output needs to default to broadly age-appropriate content without the Writer having to ask for it or configure anything.

## Decision

Age-appropriateness is a **prompting default**, not a v1 feature or a user-facing toggle. `src/lib/providers/prompt.ts`'s `buildSystemPrompt()` — shared by all three provider adapters, so the instruction exists in exactly one place — includes an explicit instruction to default to content suitable for a general audience including a child co-writing with a parent, and to avoid graphic violence, sexual content, and explicit substance use by default, "unless the story text you've been given clearly signals otherwise" (so an adult hobbyist writing a story with, say, mild violence isn't fighting the model over genre-appropriate content the Writer's own prior paragraphs already established).

No safety-level toggle, slider, or per-session setting exists in the UI, and none is planned for v1 — this was an explicit non-goal, to keep the decision a single, consistently-applied default rather than a configuration surface that could be silently left in the wrong state.

## Consequences

- The instruction lives in one file (`prompt.ts`) rather than being duplicated (and potentially drifting in wording) across three adapters.
- There's no way for a Writer to explicitly request more mature content in v1 beyond what their own story text already implies to the model — a real limitation for the hobbyist persona, acceptable because the PRD treats this as a v1-scope tradeoff, not an oversight.
- Because this is prompt-based rather than a hard content filter, it's a default the model is instructed to follow, not a guarantee — Anthropic's Claude Sonnet 5 in particular can return a `stop_reason: "refusal"` for content it declines to generate regardless of this instruction, which `src/lib/providers/anthropic.ts` detects and surfaces as an error rather than silently returning empty text.
