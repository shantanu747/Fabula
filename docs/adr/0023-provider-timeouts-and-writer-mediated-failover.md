# 23. Provider timeouts and Writer-mediated failover

## Status

Accepted.

## Context

`src/app/api/generate/route.ts` awaited a provider with no timeout anywhere. A provider that
accepted the connection and then stalled held the request open indefinitely: the Writer saw a
cursor blinking forever, the serverless invocation burned its full duration, and nothing
recovered. `request.signal` (the client's own disconnect) was read nowhere, so an abandoned
browser tab kept the upstream provider call — and its billing — running to completion. ADR 0019
named this as a known gap in the E2E strategy at the time.

Separately, when a provider did fail, the Writer's only option was "Try again" against the same
provider that had just failed, even though the app has two other configured providers and ADR
0001 exists precisely so they're interchangeable.

## Decision

**Two independent timeouts, both idle-based, not total-duration caps** (`src/lib/providers/constants.ts`):
`FIRST_CHUNK_TIMEOUT_MS` (20s) bounds how long a provider gets to produce its first token;
`STREAM_IDLE_TIMEOUT_MS` (30s) bounds the gap between chunks once streaming has begun. A long
paragraph that streams steadily is never killed — only silence is.

**One `AbortController` per request, fed by two sources, with the reason tracked explicitly**
rather than inferred from `err.name === "AbortError"` (which cannot tell a client disconnect
from our own timeout apart): `request.signal`'s `abort` listener and a plain `setTimeout` that
the route arms and clears itself. `AbortSignal.timeout()` was considered but rejected — it can't
be rearmed, and the idle phase needs exactly that (reset on every chunk), so a manual timer
paired with one shared controller is what actually supports a fixed pre-first-chunk budget and a
resettable streaming-phase one off a single signal threaded into the SDK call
(`GenerateParagraphInput.signal`, read by all three adapters' `getClient().*.create(/stream(`
request options).

Wiring `request.signal` in is also what finally makes a client disconnect stop paying for
generation before the first chunk, not just during streaming (the existing `ReadableStream.cancel()`
path already covered the latter).

**Recovery is a prompt, not a silent swap.** `docs/PRD.md` §2 promises the Writer chooses the
model, and quietly substituting a different one breaks that promise and produces an unexplained
voice shift mid-story (the system prompt in `prompt.ts` has no notion of "continuing in a
different model's voice"). The rules, implemented in `route.ts`:

1. **Pre-first-chunk failure**, fast (an error, not a timeout): retry once against the same
   provider — a fresh generator, since a `.next()`-driven `AsyncGenerator` that has already
   thrown is done and will only ever yield `{done: true}` again. If the retry also fails, return
   502 with a suggested alternative.
2. **Pre-first-chunk timeout**: never retry. A timeout means slow, and retrying doubles the
   Writer's wait before they learn anything — go straight to the 502-with-suggestion.
3. **Mid-stream failure or stall**: never offer a provider switch. Prose has already streamed;
   starting a different model mid-paragraph produces a seam. This keeps today's behavior —
   `controller.error()`, the client's existing single silent retry on `stream-aborted`, then the
   error banner.
4. **Accepting a switch** changes `selectedProviderId` for the rest of the session and
   regenerates the turn from scratch. It does **not** rewrite `story.selectedProviderId` in the
   database — that column is the resume default, and `story_paragraph.providerId` (set from the
   request body's `providerId`, which the client sends as the new one) already records who
   actually wrote each paragraph. Rewriting the story's default would imply the Writer chose the
   fallback deliberately for future turns too, which they didn't; the asymmetry is deliberate.
5. **Declining** retries the original provider, identical to the pre-existing "Try again".

**The suggestion**. `registry.ts` gained `isConfigured(id)` (checks the adapter's own API-key env
var — a small map kept in the registry rather than scattering `process.env` checks) and
`suggestAlternative(excludeId)` (first other configured provider, in registry order). The 502
body carries `kind: "provider-unavailable"`, `failedProviderId`, and, only when something else is
configured, `suggestedProviderId`/`suggestedProviderName`. The message text
(`"{displayName} isn't responding right now."`) never distinguishes a bad key from an outage from
a timeout — same posture as ADR 0011's uninformative registration responses — the real cause is
in the server-side structured log (ADR 0022) only.

**Idempotent cleanup under a real race.** A genuine client disconnect can trip `request.signal`'s
abort listener *and* the platform's own `ReadableStream.cancel()` for the same event, in either
order. `pull()`'s catch defers entirely to `cancel()` when the abort reason is `"client"` (no
`finish()`, no `controller.error()` — touching a controller whose consumer is already gone risks
throwing on top of the original error), and a `finishedOnce` guard makes `finish()` itself
idempotent regardless of which path reaches it first. `iterator.return?.()` is wrapped in
try/catch for the same reason — the SDK may already be tearing down from the abort.

**Client.** `runGeneration` in `StoryContext.tsx` gained a `providerIdOverride` parameter — the
same stale-closure fix ADR 0008 used for `submitAndContinue`. `switchProviderAndRetry` dispatches
`SET_PROVIDER` and calls `runGeneration` with the override directly rather than reading
`state.selectedProviderId` back, since the dispatch hasn't re-rendered (and refreshed the
closure) yet. The error banner (`story/page.tsx`) renders two buttons — "Use {suggested}" and
"Try {failed} again" — only when `errorKind === "provider-unavailable"` and a suggestion exists;
otherwise it falls back to the single "Try again" unchanged.

## Rejected

- **Automatic/silent fallback.** Breaks the PRD's provider-choice promise and produces an
  unexplained voice shift; a human is the one waiting, so asking costs nothing a timeout hasn't
  already cost.
- **Exponential backoff.** The Writer is watching a screen, not a background job; a longer wait
  before failing is a worse experience, not a more resilient one.
- **Circuit breaking / health scoring across requests.** No traffic volume yet to justify
  aggregate state, and it would need to persist somewhere — out of scope until real usage
  patterns exist.
- **Rewriting `story.selectedProviderId` on switch.** Would conflate "used a fallback once" with
  "changed my default provider," and silently changes what a resumed story starts with next time.

## Consequences

- A stalled provider now fails in bounded time (≤20s before any output, ≤30s of silence
  mid-stream) instead of holding a serverless invocation open indefinitely.
- An abandoned browser tab stops costing money before the first chunk, not only after streaming
  has begun.
- `e2e/playwright.config.ts`'s `webServer.env` had only ever pointed `ANTHROPIC_BASE_URL` at the
  mock provider — `OPENAI_BASE_URL`/`OPENROUTER_BASE_URL` were missing, even though ADR 0019
  describes the seam as applying uniformly to all three adapters. This had gone unnoticed because
  no prior E2E spec needed a second provider to actually succeed through the mock; Plan 4's
  accept-the-suggestion test is the first one that does, and it surfaced the gap immediately (a
  real 401 from api.openai.com). Fixed alongside this change so all three adapters are equally
  mockable going forward.
- `route.ts` is not held to the 100% coverage tier `src/lib/story/**` and the provider-agnostic
  `src/lib/providers/*` files are — one defensive branch (the early-return in `pull()`'s catch
  for a client abort, deferring to `cancel()`) is reachable only by a race between two signals
  that a synthetic unit test can't cleanly force independently of the platform's own dispatch;
  the idempotency guarantee it exists for is still covered (a combined test drives both signals
  and asserts exactly one span/`finish()` call results).
- `StoryContext.tsx` remains excluded from unit-test coverage (a pre-existing, documented
  decision, not one this change revisits) — `switchProviderAndRetry`'s stale-closure correctness
  is covered at the E2E layer instead (`provider-failure.spec.ts`'s accept/decline tests), which
  is arguably a stronger check for a re-render-timing bug than a mocked unit test would be.
- Timeout values are fixed constants, not environment- or UI-configurable, including in tests —
  the one E2E spec that exercises `FIRST_CHUNK_TIMEOUT_MS` waits out the real 20 seconds rather
  than a shortened stand-in.
