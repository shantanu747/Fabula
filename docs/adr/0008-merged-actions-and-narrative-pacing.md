# 8. Merged actions and narrative-arc pacing

## Status

Accepted.

## Context

A Writer reported a UX bug: the start screen offered two separate actions — "I'll write the first paragraph" and "Get me started" — and picking the wrong one silently discarded whatever theme, characters, or opening lines they'd already typed, because the mis-clicked path navigated to `/story` without submitting any of it. The story canvas had the same two-action shape ("Add to story" then a separate "Continue →"), forcing a Writer to click twice for what is conceptually one move: write your turn, then let the AI reply.

Separately, the Writer wanted the story to have dramatic shape. Today the Writer and AI can alternate indefinitely with no rise toward a climax or a conclusion — nothing in the prompt ever nudges the AI toward wrapping up, so a story can meander forever or end arbitrarily whenever a Writer stops.

Both problems were resolved directly with the user (not assumed) before implementation:

- Opening lines, if the Writer fills them in, become their literal first paragraph — submitted as-is, never rewritten by the AI.
- Theme/characters should remain part of the AI's context on every turn, not just the opening kickoff.
- A story-length target is a Writer-set **soft** guide, not a hard cap — it must never disable continued writing.
- Accounts, a persisted story library, and social sharing are the confirmed v2 direction (see `docs/PRD.md` §3) but are out of scope for this change — doc-only for now, no code.

**A stale-closure hazard surfaced during design.** `StoryContext.tsx`'s `runGeneration` is a plain function that closes over the current render's `state`. Before this change, submitting the Writer's paragraph and triggering the AI's turn were always two separate clicks, so a re-render happened in between and the closure was never stale. Merging them into one action means calling both in immediate succession from a single click handler — naively dispatching a `WRITER_SUBMIT` action and then calling `generateNext()` back-to-back would send the AI a `storySoFar` still missing the paragraph the Writer just submitted, since the dispatch hasn't re-rendered the component (and thus refreshed the closure) yet.

## Decision

**One button per screen, inferred intent instead of an explicit mode choice.** The start screen's two actions collapse into a single "Let's write" button; the story canvas's two actions collapse into a single "Continue the Story" button. Both call one new context method, `submitAndContinue(text)`, which sidesteps the stale-closure hazard by computing the updated paragraph array explicitly and passing it straight into generation rather than reading `state.paragraphs`:

```ts
submitAndContinue: (text) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  const updated = [...state.paragraphs, { author: "writer", text: trimmed }];
  dispatch({ type: "WRITER_SUBMIT", text: trimmed });
  runGeneration(0, updated);
}
```

`runGeneration` gained an optional `storySoFarOverride` parameter for exactly this purpose — it prefers the override over `state.paragraphs` when building the API request. On the start screen, "Let's write" checks whether opening lines were typed: if so, `submitAndContinue(openingLines)` (Writer's literal first paragraph, AI replies immediately after); if not, `generateNext()` (AI writes paragraph one, inventing theme/characters if none were given). On the story canvas, every Writer turn now auto-triggers the AI's reply as part of the same click — the canvas button is single-purpose (submit draft, auto-continue), enabled only on the Writer's turn with a non-empty draft. The one remaining case of retrying an AI turn without a fresh Writer submission — a failed generation — keeps its own pre-existing "Try again" button in the error banner, calling `generateNext()` directly.

**Standing context on every turn.** `buildMessages` previously referenced `theme`/`characters`/`openingLines` only in the kickoff instruction (`storySoFar.length === 0`). A new `buildOngoingContextNote` appends a short reminder (`"Keep in mind — Genre/theme: …. Established characters: …."`) to every non-kickoff continuation message when theme/characters are set, kept as a per-request user-message addition (matching how the existing `CONTINUE_INSTRUCTION` already works) rather than folded into `buildSystemPrompt()`, so the system prompt stays a static, provider-agnostic constant shared unchanged across all three adapters.

**Soft-target length steering, not a hard cap.** A Writer-controlled slider (6–30 paragraphs, default 14) sets `targetLength`, sent with every generation request. `buildLengthSteeringNote` bands the AI's own trailing instruction by `currentCount / target`:

| Ratio | Instruction |
|---|---|
| < 0.6 | *(none — normal continuation)* |
| 0.6 – 0.85 | Start raising the stakes toward a climax. |
| 0.85 – 1.0 | This is a good point to hit the climax. |
| ≥ 1.0 | Actively resolve the plot — wrap up loose threads, close within this paragraph or the next. |

Soft over hard was a direct product decision, not a default: the target only ever changes what the AI is *told to aim for*, never what the Writer is *allowed to do* — nothing in the UI or API disables continued writing past it. `currentCount` must be the true, pre-windowing paragraph count, not the windowed count `windowStoryParagraphs` may have truncated to (see ADR 0005) — using the windowed count would understate story length on longer stories and fire the bands too late. `generateWithProvider` captures `input.storySoFar.length` before windowing and threads it through to `buildMessages` as an explicit `trueCount` parameter in all three provider adapters, rather than letting each adapter re-derive it from a possibly-truncated array.

## Consequences

- A Writer can never again lose typed input to a wrong-button click — there is only one button per screen, and it always considers whatever is in the fields.
- The Writer/AI strict one-paragraph-per-turn policy (ADR 0004) is unchanged and still enforced server-side; merging the click only changes when the AI's turn is *triggered* client-side; it does not create a second way to violate turn order.
- Any future context.tsx change that calls `runGeneration` after a dispatch must keep passing an explicit override rather than relying on `state` — the stale-closure hazard reappears for any new merged action added the same way.
- The length bands are static thresholds tuned by inspection, not measured against real generations yet; if the AI's climax/resolution language reads as too abrupt or too gradual in practice, the ratio cutoffs (0.6/0.85/1.0) are the first thing to retune, not the overall soft-target design.
- Because the target is advisory only, a Writer can keep writing indefinitely past it — this is intentional, but means "climax" language can appear more than once if the Writer keeps the story going well past its target, since the ≥1.0 band never stops re-firing.
