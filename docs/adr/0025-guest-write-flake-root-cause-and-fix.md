# 25. guest-write.spec.ts flake: root cause found and fixed — a client-side fetch/navigation race, not a timing issue

## Status

Accepted. Resolves ADR 0021's open question; supersedes ADR 0020's "not enough timeout headroom on a slow shared runner" theory for this specific flake (ADR 0020's 15s CI headroom itself is unrelated and stays, for the reason given there).

## Context

ADR 0020 and 0021 chased this flake through two theories — connection-pool reuse (ruled out) and slow-runner timing headroom (mitigated with a 15s CI timeout, but ADR 0021 recorded that CI failed the same assertion a third time even at 15s, leaving the root cause explicitly undiagnosed). Recent CI history made clear this had stopped being an occasional flake: 5 of 6 `main` runs and all 3 attempts on this PR failed, always on `guest-write.spec.ts`'s first test, always the same assertion.

With `gh` authenticated against this repo, the actual failing run's Playwright trace (`trace.zip`, `retain-on-failure`) was pulled and inspected directly — not the interleaved `[WebServer]` log text ADR 0020 warned against trusting. The trace's network log showed the `/api/generate` request completing server-side (`status: 200`, ~360-375ms, confirmed against the server's own timing logs by matching `x-request-id`) but recorded client-side as `_failureText: "net::ERR_ABORTED"`. A second, independently-captured trace from an unrelated `main`-branch failure two days earlier showed the identical signature. This directly rules out ADR 0020's "real network round trip, not enough headroom on a loaded runner" theory: the request wasn't slow, it was aborted.

`src/lib/story/StoryContext.tsx` already carried diagnostic instrumentation for exactly this (`[runGeneration:diag]`, added in `ed73a1d` per ADR 0021's own stated recovery plan) that logs every time the app's own `abortRef.current?.abort()` — the only place this codebase calls `.abort()` on that fetch's controller — actually fires. Neither trace shows that log firing. So the abort is not the app's retry/dedup logic; something external to the app aborted an in-flight, otherwise-successful fetch.

The remaining lead was the trace's action timeline: the `/api/generate` fetch is issued right as `page.waitForURL("**/story")` resolves a client-side navigation triggered by the same click. `src/app/page.tsx`'s `handleStart()` calls `generateNext()` (or `submitAndContinue()`) and then, synchronously on the next line, `router.push("/story")`. `generateNext()` only *schedules* the real `fetch("/api/generate")` behind `ensureStoryId().then(...)` in `StoryContext.tsx` — for a guest, `ensureStoryId()` has no server round trip (`if (!session?.user) return undefined`) and resolves on the very next microtask, so the actual `fetch()` call lands essentially on the same tick as the route transition kicked off by `router.push()`. For a signed-in Writer, `ensureStoryId()` does a real `POST /api/stories` first — a genuine ~100-300ms round trip — which happens to clear the transition window before the generate fetch ever fires. That asymmetry is exactly why only the guest path, and only the very first paragraph, ever hit this: every other spec that calls `startStory()` does so signed in, or after the first turn (when `ensureStoryId` is a cache hit but the earlier turns already absorbed the race). The precise browser/Next.js mechanism that aborts a fetch racing a same-tick client-side navigation was not identified further than this — the fix below doesn't depend on knowing it, only on removing the race.

## Decision

Stop racing the fetch against the navigation. `generateNext`, `submitAndContinue`, and `switchProviderAndRetry` (`StoryContextValue`) now return `Promise<void>`, resolving once `runGeneration` has actually been called — i.e. once the real `fetch()` has been issued, not once generation completes. `handleStart()` in `src/app/page.tsx` awaits that before calling `router.push("/story")`. For guests this delays the navigation by a single microtask, imperceptible; for signed-in Writers it changes nothing observable, since the navigation was already effectively gated behind the `ensureStoryId` round trip.

The other call sites (`story/page.tsx`'s `handleContinue`, the error-banner's retry/switch buttons) don't navigate, so they keep calling these functions as fire-and-forget statements — the return-type change is additive there.

Removed, as their purpose is now served: the `[runGeneration:diag]` console instrumentation in `StoryContext.tsx` (`ed73a1d`) — it did its job, ruling out the app's own abort logic — and the server-side `[generate:timing]` logs plus the `t0` timer in `route.ts`, along with `playwright.config.ts`'s `webServer.stdout: "pipe"` override that existed only to surface them in CI (its own comment already said to remove it once the timing diagnostics went away). Both were explicitly marked TEMPORARY pending diagnosis; the diagnosis is done.

## Consequences

`guest-write.spec.ts`'s first test — the one CI test that actually exercises the guest, zero-latency, first-paragraph kickoff path — should no longer race its own fetch against navigation. Verified locally: `test:e2e` (25/25) and a targeted `--repeat-each=20` soak on `guest-write.spec.ts` (60/60) both pass clean. Per ADR 0020/0021's own standard, that is not proof — this flake has never once reproduced locally, before or after this fix — so the real verification is the next live CI run actually landing green where it failed 3/3 before.

ADR 0020's 15s CI `expect.timeout` headroom is unrelated to this fix and stays; it exists for assertions genuinely sitting behind a real DB/network round trip on a loaded shared runner, which is a real and separate concern from this one aborted-fetch bug.

If CI fails this same assertion again after this change, the fetch/navigation race above is ruled out, which narrows further diagnosis considerably — and the removed instrumentation (this ADR's own trace-pulling approach, or `ed73a1d`'s console logging) is cheap to reintroduce if needed.
