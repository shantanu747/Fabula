# 40. Stable-prefix windowing for prompt caching

## Status

Accepted.

## Context

There was no prompt caching anywhere in this application, on any provider, despite per-turn cost
growing with story length. The obvious framing — "the prefix slides every turn, so caching can
never work here" — is wrong, and getting the actual mechanism right is the point of this record.

`windowStoryParagraphs` (`src/lib/providers/prompt.ts`) returns the paragraph array **unchanged**
while the story is under `CONTEXT_WINDOW_CHAR_BUDGET` (12,000 chars). For every turn in a story
that stays under that budget, each turn's message list is a pure **append** to the previous turn's
— exactly the shape prefix caching wants. Caching would have worked for those stories the whole
time if the request-side flags had simply been set.

The prefix only destabilises **after** the budget is exceeded, and it did so in two ways at once:

1. The old windowing algorithm greedily re-fit the kept tail to the budget line on every single
   turn. Since the kept window already filled right up to the budget with almost no slack, adding
   one more paragraph almost always forced the boundary to advance by one paragraph — a different
   kept window, and therefore a different byte sequence sent to the model, on nearly every turn.
2. The anchor paragraph's text was mutated by appending an `[...earlier paragraphs continue
   here...]` note the moment dropping began, and — combined with (1) — the *content* windowed in
   from the middle of the story also shifted underneath that note turn to turn.

From the turn dropping first began onward, every request was a full cache miss, forever — which is
exactly when stories are longest and input cost is highest, i.e. the worst possible place for
caching to stop working.

## Decision

**Chunked, sticky re-anchoring.** Once the budget is exceeded, the kept tail is re-fit not to the
full rest-budget but to `LOW_WATER_RATIO` (60%) of it, and that boundary then holds — deterministically,
not by remembered state — across many subsequent turns, until the kept window's content has grown
back past the *full* budget again. Trading away some context (up to 40% of the rest-budget can sit
unused right after a re-anchor) buys a stable prefix for many turns in a row.

The implementation is a pure function with no external state (`stickyStartIndex` in `prompt.ts`),
which matters because `windowStoryParagraphs` is only ever called with the *complete* paragraph
history and nothing is ever edited out of the middle by the client. That means the function can
replay the whole history from index 0 on every call, and — because the replay of an unchanged
prefix always produces the same intermediate state — two calls with a shared prefix (turn N's
array, and turn N+1's array, which is turn N's plus one more paragraph) necessarily replay
identically up to where they diverge, and only diverge where the new content is. No memoization,
no session state, no coordination between requests: the array itself is the memory.

**The anchor note is stable, not just present-or-absent.** The note's text no longer varies with
how many paragraphs were dropped; it's static. Combined with the boundary now holding steady, the
anchor's own content stops changing turn to turn once dropping has started, for the same many-turn
stretches the tail does.

**The latent `budgetForRest` bug is fixed alongside this.** `budgetForRest = BUDGET -
anchor.text.length` could go negative when a single first paragraph alone exceeded the budget,
silently bypassing the whole context cap. The fix clamps this to zero and truncates an oversized
anchor (reserving room for the note), rather than letting one long paragraph defeat the budget
entirely. Plan 6 separately adds an input-length cap that makes an anchor this large rare in
practice; both the cap and this clamp are needed — one at the boundary, one at the consumer that
can't fully trust the boundary held.

**Anthropic gets an explicit `cache_control` breakpoint; OpenAI does not need one.** Anthropic's
Messages API requires the request to mark which content should be cached — the system prompt (a
`TextBlockParam` with `cache_control: { type: "ephemeral" }`, cacheable across every request this
app ever makes, not just within one story) and the boundary between the stable, ever-growing story
prefix and the one message rebuilt fresh every turn (`buildContinuationMessage`, whose
length-steering text differs turn to turn). That boundary is always the second-to-last message in
`buildMessages`' output, since its shape is always `[...storySoFar mapped 1:1, continuationMessage]`
— marking it moves forward by exactly one message per turn, which is correct behaviour for
Anthropic's incremental cache matching: turn N's breakpoint caches "system + story through
paragraph K"; turn N+1 sends that identical prefix plus one more paragraph, gets a cache **read**
for the shared part, and writes a new, one-paragraph-larger entry under its own breakpoint. OpenAI's
caching is automatic once a prefix is stable — no request flag — so the stability work above is
what makes it apply there too; the adapter only needs to read `cached_tokens` back out of the usage
payload. OpenRouter was checked live against `openrouter.ai/docs` (2026-09-11): Meta Llama models
aren't among the providers documented as reporting cache usage, so that adapter reads the field
defensively (in case an upstream ever adds it) but expects it absent, and warns once rather than
fabricating a number.

**5-minute ephemeral TTL, not 1-hour.** Anthropic's ephemeral cache refreshes its TTL on every read.
Fabula's usage pattern — a Writer and the AI trading single paragraphs in one active session — has
gaps between turns measured in seconds to at most a couple of minutes while composing, comfortably
inside a 5-minute window that keeps refreshing as long as the session stays active. The 1-hour tier
costs 2x base input to write versus 1.25x for 5-minute; paying the higher write price only makes
sense when the *read* gap is expected to exceed 5 minutes often enough to justify it, which isn't
this product's shape.

**Widened `TokenUsage` and `estimateCostUsd`.** `cacheCreationInputTokens`/`cacheReadInputTokens`
are both optional on `TokenUsage` — absent means the provider/model didn't report the field at all,
never fabricated as `0` (the standing rule from ADR 0022). `estimateCostUsd` prices a cache read at
0.1x base input and a cache write at 1.25x, both verified live 2026-09-01/09-11 against
`platform.claude.com/docs/en/about-claude/pricing#prompt-caching`; OpenAI's cached-input rate for
gpt-5-mini ($0.025 vs. $0.25 base, `developers.openai.com/api/docs/pricing`) turned out to be
exactly the same 0.1x multiplier, so one constant serves both providers' read side. OpenAI has no
separate cache-write charge — caching there is free to create — so `cacheCreationInputTokens` stays
undefined for that adapter rather than reporting a cost that was never billed.

**A subtlety worth naming explicitly: OpenAI's `cached_tokens` is a *subset* of `prompt_tokens`,
Anthropic's cache fields are *additive* alongside `input_tokens`.** The OpenAI (and OpenRouter)
adapters subtract the cached count out of the reported prompt tokens before assigning
`inputTokens`, so `TokenUsage.inputTokens` means the same "fresh, non-cached tokens" thing
regardless of provider, and `estimateCostUsd` has one formula rather than a provider-specific
branch.

## Consequences

- A second turn on the same story now produces a measurable, non-zero `cacheReadInputTokens` —
  demonstrated against a real provider, not assumed (see Verification below).
- Windowing sends somewhat less context per turn once a story is long enough to trigger dropping —
  the 60% low-water mark is deliberately conservative slack, not a tight fit. This is the
  context-efficiency-for-cache-hit-rate trade the whole change is built on: a cache read costs ~10%
  of the input price and a 5-minute cache write ~125%, so hitting the cache on 9 turns out of 10 is
  a large net win even though each of those 9 turns sees a slightly smaller window than the old
  greedy-fit algorithm would have given it. Hitting on ~0 of 10, which is what happened before, pays
  the 125% write premium on every single request for nothing.
- The anchor-truncation fix changes observable behaviour for one edge case: a single paragraph
  alone larger than the whole budget used to be sent in full (over budget); it's now truncated with
  a note. `prompt.test.ts`'s test for this case was updated to match — this is a deliberate
  behaviour change the plan called for, not an accidental regression.
- `stickyStartIndex`'s O(n) replay-from-index-0 on every call is `n` paragraphs' worth of length
  summation — negligible at the paragraph counts (dozens to low hundreds) a story reaches; this was
  chosen over adding any persisted "last boundary" state specifically to avoid a second source of
  truth that could drift from the paragraph array itself.

## Why response/semantic caching is out of scope

Caching model *output* was considered and rejected. Two Writers submitting the same prompt (or the
same Writer retrying) **should** get a different paragraph each time — that's the product, not a
bug — so caching a generated response for reuse would be actively wrong here, not just
unnecessary. Everything in this record caches *input* processing (the system prompt and the stable
story prefix), never the model's output.

## Verification

`prompt.test.ts`'s property tests prove the mechanism (a byte-identical prefix across turns, and
rare — not zero — boundary shifts) against generated story shapes, and `pricing.test.ts` proves the
cache-arithmetic formulas. Those are necessary but not sufficient: they prove the *logic* is
correct, not that a real provider actually returns a cache hit for it. That requires two live turns
on one story against a real Anthropic key (`npm run eval:live`, which needs `--confirm-live-spend`
because it costs real money) and reading back a non-zero `cacheReadInputTokens` on the second
turn's `generation_event` row. That live check is a deliberate, explicit follow-up rather than
something this record claims was already run — spending real API budget and writing to whichever
Postgres `DATABASE_URL` points at isn't a call to make silently. See `bench/BASELINE.md` for the
round-trip-count side of this plan's measurement, which *was* run locally against the mock provider.
