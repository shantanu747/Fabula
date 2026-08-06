# 5. Context window management

## Status

Accepted.

## Context

A story has no length limit in the UI, but every generation call sends the story-so-far to a provider as conversation history, and the PRD names a "global reasonable per-request token cap" as a required cost-control mitigation. Left unbounded, a long story would eventually exceed a provider's context window outright, and even before that point, sending ever-more history means an ever-growing (and ever more expensive) request for every single paragraph generated. There's also a quality concern distinct from cost: as a story grows, an LLM re-reading the entire history on every call is more prone to drifting in tone or contradicting earlier details the more text there is to track.

The client always holds (and displays) the complete, uncompacted story — this constraint is about what gets *sent to the model*, not what the Writer can see or has written.

## Decision

`src/lib/providers/prompt.ts`'s `windowStoryParagraphs()` compacts the story sent to a provider using an **anchor-plus-recency** strategy, not naive truncation from the end and not summarization:

1. If the full story's total character length fits within `CONTEXT_WINDOW_CHAR_BUDGET` (`src/lib/providers/constants.ts`), it's sent unchanged — the common case for most stories.
2. Otherwise, the **opening paragraph is always kept** (it typically carries the theme, characters, and premise the rest of the story depends on), plus as many of the most **recent** paragraphs as fit the remaining budget.
3. If paragraphs were dropped from the middle, a short note — `"[...earlier paragraphs continue here, omitted for length...]"` — is appended to the anchor paragraph, so the model is told the gap is intentional rather than left to guess or paper over it. `src/lib/providers/prompt.ts`'s system prompt explicitly instructs the model to treat this note as real, unseen story history rather than an invitation to invent contradicting details.

Naive from-the-end truncation was rejected because it would eventually drop the opening paragraph itself on a sufficiently long story — losing exactly the theme/character/premise information most load-bearing for staying on-topic. Summarization (compressing dropped paragraphs into a synthesized recap rather than dropping them outright) was considered and explicitly deferred: it would need its own LLM call (cost and latency) and its own accuracy risk (a bad summary actively misleading the model is arguably worse than an honest gap), and isn't needed until real usage shows truncation-only is insufficient.

The same fixed character budget is applied uniformly across all three providers, even though their actual context windows differ substantially (Claude Sonnet 5's is far larger than the OpenRouter Llama model's 131K tokens) — a deliberate v1 simplification, not a per-provider-tuned budget.

## Consequences

- Cost per generation call is bounded regardless of story length.
- The premise established in a story's opening paragraph is never silently lost, even in a very long story — the failure mode of naive truncation.
- The uniform, not-per-provider budget is conservative for the largest-context provider and potentially not maximally utilizing it — an acceptable v1 tradeoff, revisit if a specific provider's output quality suffers from under-using its available context.
- Because this operates purely on paragraph text length as a proxy for token count, it doesn't precisely match any provider's actual tokenizer — it's intentionally a rough, safe-by-a-margin budget rather than an exact one.
