# Plan 4 — Provider timeouts and ask-the-Writer failover

**Branch:** `feature/provider-failover-prompt`
**Depends on:** Plan 3 (same interface surface — land after it). Plan 2 for the E2E specs.
**ADR:** required.

## Why this exists

`src/app/api/generate/route.ts` awaits the provider with no timeout anywhere. A provider that
accepts the connection and then stalls holds the request open indefinitely: the Writer sees a
cursor blinking forever, the serverless invocation burns its full duration, and nothing
recovers. The `cancel()` handler only fires if the *client* goes away.

Separately, when a provider does fail, the Writer's only option is "Try again" against the same
provider that just failed — even though the app has two other configured providers and
`docs/adr/0001` exists precisely so they're interchangeable.

The recovery is a **prompt, not a silent swap**: `docs/PRD.md` §2 promises the Writer chooses
the model, and quietly substituting a different one breaks that promise and produces an
unexplained voice shift mid-story.

## What "done" means

- A stalled provider fails in bounded time with a clear error, both before the first chunk and
  mid-stream.
- A pre-first-chunk failure offers the Writer a named alternative provider, which they accept
  or decline.
- No code path switches provider without an explicit Writer action.
- Client disconnect cancels the upstream provider call instead of merely abandoning it.

## The rules — implement exactly these

1. **Pre-first-chunk failure** (the 502 path that already exists): retry **once** against the
   same provider if the failure was *fast* (an error, not a timeout). Then, if it still fails,
   return 502 with a suggested alternative and let the UI ask.
2. **Pre-first-chunk timeout**: do **not** retry. A timeout means slow, and retrying doubles the
   Writer's wait before they learn anything. Go straight to the 502-with-suggestion.
3. **Mid-stream failure or stall**: never offer a provider switch. Partial prose already
   streamed, and starting a different model mid-paragraph produces a seam. Keep today's
   behaviour — `controller.error()`, the client's existing single silent retry on
   `stream-aborted`, then the error banner.
4. **Accepting a switch** changes `selectedProviderId` for the rest of the session and
   regenerates the turn from scratch. It does **not** rewrite `story.selectedProviderId` in the
   database — that column is the resume default, and `story_paragraph.providerId` already
   records who actually wrote each paragraph. Note this asymmetry in the ADR.
5. **Declining** retries the original provider, exactly as the current "Try again" does.

## Timeouts

`src/lib/providers/constants.ts` (100% coverage tier — new constants need a test that
exercises them):

```ts
/** Budget for the provider to produce its first token. Beyond this the Writer is
 *  staring at nothing, and a slow start rarely recovers into a fast stream. */
export const FIRST_CHUNK_TIMEOUT_MS = 20_000;

/** Max gap between chunks once streaming has begun. Generous — some models pause
 *  mid-paragraph — but bounded, so a half-open connection cannot hang forever. */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;
```

These are *idle* timeouts, not total-duration caps. A long paragraph that streams steadily must
never be killed.

## Implementation

### Interface: thread an abort signal

`GenerateParagraphInput` gains `signal?: AbortSignal`. Each adapter passes it into its SDK call
— both the Anthropic and OpenAI SDKs accept `{ signal }` in per-request options; confirm the
exact shape against `node_modules/@anthropic-ai/sdk` and `node_modules/openai` rather than from
memory.

Update `AGENTS.md`'s inlined interface snippet if the change is visible there, and update every
construction site — including `evals/` from Plan 1.

### Route: compose the signals

In `src/app/api/generate/route.ts`, build a controller that aborts on any of:

- `request.signal` (client disconnected — currently unused, and wiring it means an abandoned
  browser tab stops costing money);
- `AbortSignal.timeout(FIRST_CHUNK_TIMEOUT_MS)` for the pre-first-chunk phase;
- an idle timer, reset on every chunk, for the streaming phase.

`AbortSignal.any([...])` composes them. Distinguish *why* it aborted — a client disconnect is
`fabula.outcome = cancelled` and must not produce an error response, while a timeout is a 502.
Track the reason explicitly rather than inferring it from `err.name === "AbortError"`, which
cannot tell them apart.

Clear the idle timer in every terminal path (`done`, error, `cancel`), or the process holds a
timer per abandoned stream.

### Route: the suggestion

Add to `src/lib/providers/registry.ts`:

```ts
/** Whether a provider can actually be called — its key is configured. Returns a
 *  boolean only; never expose which env vars are set, or their values. */
export function isConfigured(id: string): boolean

/** The first configured provider other than `excludeId`, in registry order.
 *  Undefined when nothing else is available. */
export function suggestAlternative(excludeId: string): string | undefined
```

`registry.ts` is in the 100% coverage tier. Both functions need full-branch tests, including
"nothing else configured".

Checking configuration means reading the same env var the adapter reads. Keep that mapping in
the adapter file (export a `isConfigured()` per provider on the `LLMProvider` interface, or a
small map in the registry) — do not scatter `process.env.ANTHROPIC_API_KEY` checks across the
codebase.

The 502 body becomes:

```json
{
  "error": "Claude (Anthropic) isn't responding right now.",
  "kind": "provider-unavailable",
  "failedProviderId": "anthropic",
  "suggestedProviderId": "openai",
  "suggestedProviderName": "GPT-5 mini (OpenAI)"
}
```

`suggestedProviderId` and `suggestedProviderName` are omitted when nothing else is configured;
the UI must handle that and fall back to a plain "Try again".

The message must not distinguish "bad API key" from "provider down" from "timed out" to the
client — same reasoning as ADR 0011's uninformative registration responses. Log the real cause
server-side (Plan 3's logger) and keep the client message generic.

### Client

`src/lib/story/types.ts` — `GenerationErrorKind` gains `"provider-unavailable"`, and the error
variant of `GenerationState` gains optional `failedProviderId`, `suggestedProviderId`,
`suggestedProviderName`.

`src/lib/story/streamGeneration.ts` — the `!response.ok` branch currently maps status to kind.
It must now read `kind` from the parsed body when present and prefer it over the status
mapping, carrying the suggestion fields through `GenerationError`. Keep the status fallback for
a 502 without a body.

`src/lib/story/StoryContext.tsx` — `GENERATION_ERROR` carries the new fields. Add a
`switchProviderAndRetry(providerId: string)` to the context value that dispatches `SET_PROVIDER`
and then runs generation with the new id.

**The stale-closure trap.** `runGeneration` reads `state.selectedProviderId` from the render
closure. Dispatching `SET_PROVIDER` and immediately calling `runGeneration()` will send the
*old* provider — this is the exact bug `docs/adr/0008` records and fixed for `submitAndContinue`
by passing the updated value directly. Do the same: give `runGeneration` a `providerIdOverride`
parameter, and use it for both the request body and the `providerId` recorded on the resulting
paragraph in `GENERATION_DONE`.

`src/lib/story/**` is at 100% coverage. Every new branch needs a test.

### UI — `src/app/story/page.tsx`

The existing error block already has `role="alert"`. Extend it: when
`errorKind === "provider-unavailable"` and a suggestion exists, render two buttons —
"Use {suggestedProviderName}" and "Try {failedProviderName} again" — instead of the single
"Try again". Keep the existing suppression rules (no retry for `turn-violation` or
`rate-limited`) untouched.

Both buttons need the `tap-target` class already used elsewhere, and the pair must wrap rather
than overflow at 375px. Check it at 375px before calling this done — AGENTS.md requires it, and
a two-button row is exactly what breaks.

## Tests

- `registry.test.ts` — `isConfigured` and `suggestAlternative` across: all configured, only the
  failing one configured, none configured, and registry-order determinism.
- Route tests with a fake provider that (a) throws immediately, (b) throws twice, (c) never
  yields, (d) yields two chunks then stalls, (e) aborts via a client-side signal. Use Vitest
  fake timers for the timeout paths — never a real 20-second wait. Assert: exactly one retry in
  case (a), no retry in case (c), 502 shape and suggestion in (b) and (c), mid-stream stall
  produces a stream error and no suggestion in (d), and (e) produces no error response and a
  `cancelled` outcome.
- `streamGeneration.test.ts` — body `kind` beats status mapping; a 502 with no body still maps
  to `provider-failed`; suggestion fields survive to the callback.
- `StoryContext` — cover `switchProviderAndRetry`, and specifically assert the request carries
  the *new* provider id on the very next call (the stale-closure regression).
- E2E: replace the `TODO(plan-04)` assertion left in `e2e/specs/provider-failure.spec.ts` by
  Plan 2. Add: mock hangs → error banner appears within the timeout budget and names an
  alternative; clicking it produces a paragraph attributed to the second provider; declining
  retries the first. Use the mock's `hang` and `error` response kinds.

## Gotchas

- `AbortSignal.timeout` and `AbortSignal.any` need Node 18+/20+; the runtime is Node 22, so
  both are fine, but confirm the Edge runtime isn't involved — this code is in a route handler,
  which is Node.
- The route currently calls `iterator.return?.(undefined)` on cancel. With a real signal wired
  in, the SDK may already be tearing down; make the call idempotent-safe and don't let a throw
  from it mask the original outcome.
- The retry in rule 1 must construct a **fresh** generator. An `AsyncGenerator` that has thrown
  is done; calling `.next()` again yields `{ done: true }` and you will ship an empty paragraph.
- Retrying must not double-charge the rate limiter. `guardGenerate` runs once, before
  generation; keep it there and do not re-guard the internal retry.
- Persistence interaction: with `storyId` set, `syncStoryParagraphs` already ran before the
  first attempt. The retry must not re-sync, and `aiPosition` must stay the value computed then
  — re-deriving it is precisely the bug ADR 0016 fixed. Do not touch that code path.
- If the Writer switches provider, `GENERATION_DONE` must record the *new* `providerId` on the
  paragraph, and `insertAIParagraph` must receive it too, or the per-paragraph attribution in
  the UI and the database will disagree.

## Out of scope

- Circuit breakers, health scoring, or automatic provider ranking.
- Silent/automatic failover of any kind.
- Retrying mid-stream against a different provider.
- Exposing timeout values in the UI or making them user-configurable.
- Updating `story.selectedProviderId` on switch (explicitly decided against above).

## ADR

`docs/adr/00NN-provider-timeouts-and-writer-mediated-failover.md`. Cover:

- Why there was no timeout, and what a stalled provider actually cost.
- Why failover asks rather than switches, tied to the PRD's provider-choice promise and to the
  voice-consistency requirement in `buildSystemPrompt()`.
- Why fast failures retry once but timeouts don't.
- Why mid-stream failures never offer a switch.
- Why `story.selectedProviderId` is not rewritten, and that `story_paragraph.providerId` is the
  real record.
- Rejected: automatic fallback (breaks the promise, unexplained voice shift), exponential
  backoff (a human is waiting), circuit breaking (no traffic yet to justify the state).
