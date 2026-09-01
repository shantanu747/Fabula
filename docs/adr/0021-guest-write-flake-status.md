# 21. guest-write.spec.ts flake: current status is mitigated, not resolved

## Status

Accepted. Supersedes ADR 0020's open question, not its decision — the 15s CI timeout and `test:e2e:soak` stay.

## Context

ADR 0020 raised `expect.timeout` to 15s under CI as a reasoned-but-unverified mitigation, and named its own falsification condition: if CI failed the same assertion again even at 15s, the timing-headroom theory would be wrong.

It failed again at 15s, on the third CI attempt. The call log this time showed the same locator resolving 5 times over the full 15s window, stuck at `"Claude (Anthropic)▍"` on both the attempt and its retry — never progressing, not even partially. The accessibility snapshot captured at the moment of failure (`error-context.md`, attached to the Playwright report) showed something more specific: **the paragraph had, by then, fully completed and committed** — full text, the invented-theme chip rendered, "Paragraph 2 of ~14" showing. So the generation itself succeeds; it just produces no client-visible progress for most of 15 seconds and then lands all at once. That rules out "slow but arriving" (ADR 0020's theory) as cleanly as ADR 0020's own repro had ruled out the connection-pool-reuse theory before it.

`src/app/api/generate/route.ts` pre-fetches the first generated chunk (`first = await iterator.next()`, after `guardGenerate`'s DB-backed rate-limit check) *before* the `Response` — including headers — is ever returned to the browser. The client renders the streaming attribution optimistically, on submit, not on first byte (`isStreaming` in `src/app/story/page.tsx`). So a stall in either of those two awaits is structurally invisible to the browser as anything but a pending fetch, which matches the observed symptom exactly. This is a real, plausible mechanism — but it is a mechanism, not a confirmed cause.

Timestamped diagnostic logging (`[generate:timing]`, bracketing `auth()`, `guardGenerate`, and the first `iterator.next()`) was added to `route.ts` to get a real answer from the next CI run rather than a fourth guess. Local baseline across 3 full-suite runs: consistently 100–225ms end to end for all three stages — normal. That commit was pushed, and the very next CI run of `guest-write.spec.ts` **passed**.

A pass proves nothing here. The diagnostic logging was inert (`console.log` calls; no behavior change), and this flake has always passed far more often than it's failed — roughly 15+ clean CI runs against 3 failures before this point. A clean run was already the expected outcome most of the time, instrumented or not; it did not exercise the stall, so no timing data was collected. The mechanism above remains a hypothesis, not a finding.

## Decision

Remove the diagnostic logging and the `webServer.stdout: "pipe"` config change that supported it (`git revert`, matching ADR 0020's own practice of reverting rather than silently dropping, so the attempt stays visible in history) — leaving them in place with no plan to act on their output is clutter, not verification-in-progress.

Accept the current state as a **mitigation, not a fix**: the 15s CI timeout stands, the root cause (most likely, but not confirmed: a stall in `guardGenerate` or the provider's first-chunk fetch, invisible to the browser because of the optimistic-render + pre-fetch-before-headers structure above) is undiagnosed. Stop spending further rounds on it now rather than keep re-deriving the same open question from log text.

## Consequences

If this recurs, the fastest path to an actual answer is not another log-reading pass — it's re-adding equivalent timing instrumentation (this ADR's own attempt can be resurrected from its reverted commit) and, critically, *not reverting it* until a failing run has actually been caught with it in place. A pass with instrumentation attached and no failure to show for it is not evidence of anything, in either direction.

If it does not recur for a meaningful stretch (a rough heuristic: comparable to the ~15+ clean runs already seen before the first failure), that's weak evidence the 15s headroom is sufficient in practice, whatever the underlying mechanism — worth revisiting this ADR's status at that point, but not a thing to assert today.
