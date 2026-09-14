# 45. Provider circuit breaker

## Status

Accepted. Extends ADR 0023 rather than reversing it — see below for the item this ADR reopens.

## Context

ADR 0023 gave `/api/generate` two idle-based timeouts (`FIRST_CHUNK_TIMEOUT_MS`, 20s;
`STREAM_IDLE_TIMEOUT_MS`, 30s) and a one-retry-then-fail rule, but explicitly rejected circuit
breaking at the time: *"No traffic volume yet to justify aggregate state, and it would need to
persist somewhere — out of scope until real usage patterns exist."* Plan 2 (ADR 0035) subsequently
gave this app exactly that: a Redis tier for state that's cheap to lose and expensive to make
durable. That resolves the "would need to persist somewhere" half of the original objection. The
"no traffic volume yet" half is still true in the sense that this app has no production traffic
history to tune against — the same judgment-call posture `RESUME_GRACE_MS` (ADR 0043) and the
original timeout values (ADR 0023) already carry, not a claim this plan manufactures data to avoid.
What changed isn't the data; it's that the mechanism to act on it now exists cheaply, where it
previously didn't exist at all.

Without a breaker, every request during a real provider outage still pays the full
`FIRST_CHUNK_TIMEOUT_MS` before failing — the app has no memory that the last fifty requests to that
provider all failed the same way.

Spec: `docs/plans/v4/05-resilience.md`.

## Decision

**A per-provider breaker in Redis, closed / open / half-open, mirroring `src/lib/admission/lease.ts`'s
existing patterns rather than inventing new ones:** a Lua script for every state transition that
needs to be atomic, `withKvTimeout` bounding every call so a slow Redis never adds latency in front
of TTFT, and fail-open with nothing configured — identical reasoning to admission control's own
"a Redis outage must never stop people writing," here "must never make provider selection *stricter*
than doing nothing."

**Opens after `FAILURE_THRESHOLD` (5) consecutive qualifying failures**, counted once per incoming
request — not once per raw provider call. A pre-first-chunk fast failure already gets one same-
provider retry (ADR 0023, rule 1); both the original attempt and its retry failing is one signal
about that provider's health, not two, and double-counting would open the breaker roughly twice as
fast as the number actually means.

**Only a failure that indicates provider health counts.** A 5xx, a connection failure, or our own
`FIRST_CHUNK_TIMEOUT_MS` firing all count. A provider 429 does not — that's quota, and opening the
breaker on it would convert a throttle affecting one request into an outage affecting every Writer
routed to that provider. A client disconnect does not either; it says nothing about whether the
provider is healthy. Both SDKs (`@anthropic-ai/sdk`, and `openai`, which OpenRouter also uses)
surface a 429 as `APIError` with `.status`, which is what `isProviderQuotaError` checks — no new
error-shape convention invented for this.

**While open, the breaker denies before the route ever calls `attemptFirstChunk` — not just its
retry.** This is the actual latency win the plan names: without a breaker, a known-down provider
still costs every Writer the full 20s before the existing retry-then-fail logic even runs; with one,
the same 502-with-suggestion arrives in well under a second, using the exact response shape a real
failure produces. The Writer cannot tell the difference, by design (ADR 0011's uninformative-failure
posture, reused rather than reinvented).

**Half-open is a derived condition, not a stored third state.** The breaker only ever persists
`"open"` (with `openedAt`) or nothing (`"closed"`, implicitly). Once the cooldown (`COOLDOWN_MS`,
30s) has elapsed on an open breaker, exactly one caller may claim a separate, short-lived probe lock
(`SET NX EX`) inside the same atomic script that reads the state — Redis serializes script
execution, so however many requests race this at once, only one can win the claim. Every other
caller during that same window is denied, same as a still-open breaker. This is why the check and
the probe claim are one Lua script rather than a read followed by a separate write: a read-then-act
version would let concurrent callers all observe "cooldown elapsed, not yet claimed" and all become
probes, turning the one-probe guarantee into a burst exactly when the provider is least likely to
handle one.

**A probe's own outcome is decisive**, deliberately not requiring another five failures to re-open:
success closes the breaker outright (`DEL`s the state, including the failure count — a probe
succeeding is exactly what closing is for), failure re-opens immediately and restarts the cooldown.
The probe lock is released on failure so the *next* cooldown can produce a fresh probe, and on
success implicitly (the whole key is gone).

**Extends ADR 0023's Writer-mediated failover; does not replace it.** The breaker changes how
quickly the 502-with-suggestion arrives, never whether one arrives instead of a silent switch. A
denial produces the identical response a real failure would, is logged the same way, and the
suggested-alternative flow (`suggestAlternative`, the "Use {provider}" banner action) is completely
unaware the breaker exists. Automatic failover on an open breaker was considered and rejected for
the same reason ADR 0023 rejected it the first time: a human is watching, and asking costs nothing a
timeout hasn't already cost.

## Rejected

- **Circuit breaking at all, as ADR 0023 originally concluded.** No longer holds now that Plan 2
  gave this app cheap, disposable shared state to keep the counter in — see Context.
- **Auto-switching providers when the breaker opens.** ADR 0023 chose asking over switching
  deliberately; this plan changes latency to the question, not the decision to ask it.
- **Counting a provider 429 toward the breaker.** Would let a legitimate rate limit from the
  provider itself masquerade as an outage and take that provider away from every other Writer.
- **A read-then-write half-open check.** Races under concurrent traffic exactly when a burst of
  simultaneous probes is least wanted — see the half-open discussion above.
- **Persisting three explicit states (closed/open/half-open).** Half-open is fully recoverable from
  "open" plus a cooldown comparison plus whether the probe lock is currently claimed; a third stored
  state would be one more place for the two representations to drift.

## Consequences

- `src/lib/providers/circuitBreaker.ts` is new, held to the same 100% coverage tier as
  `admission`/`kv`/`budget` (`vitest.config.mts`) — a wrong fail-open/fail-closed branch here is
  exactly that tier's "expensive to get wrong" bar: either a permanently-tripped breaker refusing a
  healthy provider, or a broken probe claim letting an unbounded thundering herd through on every
  cooldown tick.
- The breaker is keyed globally per provider in Redis, not per deployment or per instance — the
  intended behavior (one outage's signal reaches every instance immediately) but also means a
  poisoned counter (a bug that fails fast against a healthy provider) affects every Writer at once,
  not just one instance's traffic. Bounded by `STATE_TTL_SECONDS` (5 minutes) and inspectable
  directly in Redis by key (`breaker:<providerId>:state`).
- `FAILURE_THRESHOLD` and `COOLDOWN_MS` are judgment calls, stated as such rather than measured —
  the same posture ADR 0023's and ADR 0043's own timing constants already carry, for the same
  reason: no real production traffic exists yet to tune against. Revisit once it does.
- New `LOG_EVENTS.BREAKER_REJECTED` — a denial is logged the same way admission/budget/rate-limit
  rejections already are, through the existing structured logger and its redaction allowlist,
  nothing new there.
