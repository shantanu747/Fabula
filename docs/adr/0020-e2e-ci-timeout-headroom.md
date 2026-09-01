# 20. CI-only expect timeout headroom, and how not to diagnose e2e flakiness

## Status

Accepted.

## Context

`e2e/specs/guest-write.spec.ts`'s first test — asserting the streaming preview shows real prose within Playwright's default 5s `expect` timeout — failed intermittently in the `e2e` CI job (ADR 0019) on two separate PR pushes, always the same assertion, always passing locally.

Two prior fixes were pushed to CI before this one, both wrong:

1. **`test:e2e` missing `--config e2e/playwright.config.ts`.** Real bug, real fix (the script ran with Playwright's built-in defaults and tried to execute Vitest unit tests as specs), but unrelated to this flake — it surfaced first only because it failed loudly enough to mask the flake underneath.
2. **`Connection: close` on every mock-provider response**, on the theory that `provider-failure.spec.ts`'s deliberate truncate/hang responses were leaving a dead keep-alive socket in the app's shared provider-SDK connection pool for the *next* test's unrelated request to race against — explaining the `SocketError: other side closed` / `HPE_INVALID_EOF_STATE` noise sitting right next to the failure in the CI log.

(2) was diagnosed from CI log text alone and looked convincing: the timing lined up, the error classes were the right shape for a socket-reuse race. It shipped, and CI failed again at the same assertion, now with a *different* client parser error (`HPE_INVALID_EOF_STATE` instead of `SocketError`) — consistent with a change that shifted the race's exact failure mode without touching its cause.

**The actual mistake: trusting `[WebServer]`-prefixed log line order as evidence of causation.** Playwright's webServer output is a separate, asynchronously-piped stream from its own test reporter; the two interleave in whatever order Node happens to flush them, not the order events actually occurred in. The "mock provider exploded" / "stream ended without producing a Message" cluster that appeared to immediately precede every failure is `provider-failure.spec.ts`'s own deliberate error-path assertions — present, in that exact shape, on *every single run of the suite*, including the ones that pass 18/18. It was never evidence of anything happening to `guest-write.spec.ts`.

This was only caught by building a better local reproduction: `npx playwright test --repeat-each=15 e2e/specs/provider-failure.spec.ts e2e/specs/guest-write.spec.ts` (both files, interleaved, 15x each, one continuous server and connection pool — the condition (2)'s theory specifically predicted would fail) ran 90/90 clean. A single full-suite run restarts the server from scratch each time, so it never puts enough traffic through one pool to test a pool-reuse theory at all; that's why five clean full-suite runs after fix (2) proved nothing.

With the connection-pool theory eliminated, and with `guardGenerate` (`src/lib/ratelimit/guard.ts`) confirmed to put a real DB write through the Neon HTTP proxy in front of *every* generate call — including guest calls, ADR 0015 — the remaining explanation is unglamorous: this assertion sits behind a real network + DB round trip, GitHub's shared `ubuntu-latest` runners (2 vCPU) are measurably slower and noisier than a dev machine, and 5s is not much headroom for that on a loaded runner. This can't be proven the same way the pool theory was disproven — there is no local way to reproduce GitHub Actions' specific resource contention — so this ADR records the reasoning rather than a repro.

## Decision

Raise `expect.timeout` in `e2e/playwright.config.ts` to 15s under `CI`, leaving the 5s default for local runs where the flake has never once reproduced. Revert fix (2) (`git revert`, kept as an explicit commit rather than a silent drop, so the ruled-out theory stays visible in history) — it added a real behavior change (every mock response now forces a fresh TCP connection) to fix a bug it didn't cause, which is worse than doing nothing.

Add `npm run test:e2e:soak` (`playwright test --repeat-each=10`, ~10 minutes) as the standard tool for verifying an e2e-flakiness fix before pushing it. A single clean run — local or CI — is not evidence a flake is fixed; a flake that failed twice in two CI attempts can pass 5/5 locally by construction (fresh server, small sample) without the fix addressing anything.

## Consequences

CI has 3x the headroom on every assertion, which will also quiet down any other borderline-timing assertion in the suite, not just this one — a broader hedge than a one-line fix at `guest-write.spec.ts:29`, deliberately: nothing rules out the same runner-speed variance hitting a different assertion next.

If this *doesn't* fully resolve it — CI fails this same assertion again even at 15s — that reopens the diagnosis with the pool-reuse and cold-DB theories already eliminated, which narrows the search considerably next time.

## Rejected

- **A longer timeout on just the two `toContainText` calls in `guest-write.spec.ts`.** Narrower, but every other spec asserting on early streaming state (`turn-policy.spec.ts`, `resume-story.spec.ts`) has the identical DB-then-network shape and no principled reason to be exempt from the same runner-speed variance.
- **Keeping the `Connection: close` change alongside the timeout bump, on the theory that it's harmless.** It isn't verified harmless — forcing a fresh TCP connection per request on an already CPU-constrained runner is, if anything, a plausible way to make the real (timing) problem marginally worse. An unverified change defended as "shouldn't hurt" is exactly the pattern this ADR exists to stop.
