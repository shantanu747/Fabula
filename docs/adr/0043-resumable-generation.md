# 43. Resumable generation

## Status

Accepted.

## Context

Before this change, a client disconnect — mid-stream or pre-stream — aborted the provider call
immediately (`route.ts`'s `request.signal` abort listener). That's a deliberate cost saving: an
abandoned tab stops spending money the instant it's abandoned. But it means a paragraph that was
most of the way to finishing, lost only to a lock screen or a tunnel blip (a mobile co-writing
session — a stated PRD persona — drops connections often enough for this to matter), is gone
outright: the tokens were paid for, the generation may have completed server-side moments later,
and the Writer gets nothing back for it.

The framed protocol (docs/adr/0042) is what makes resume possible at all: it gives every event a
monotonic id and the `Last-Event-ID` reconnection mechanism a resume needs, and it's what lets a
mid-stream failure be reported as a clean, typed terminal frame instead of an abnormal stream
termination a resumed connection would have nothing to pick back up from.

Spec: `docs/plans/v4/04-streaming-protocol-v2.md`.

## Decision

**The tradeoff, stated in dollars.** On a disconnect *after streaming has started* (never before —
see below), and only when Redis is configured, the provider call keeps running, unresumed, for up
to `RESUME_GRACE_MS`. That's real spend on every abandoned request within the window, traded
against not losing a paragraph across exactly the kind of connection drop the mobile persona is
expected to hit regularly. `STREAM_IDLE_TIMEOUT_MS` (the existing idle-stall timeout) keeps
running independently during the grace window — a genuinely stalled provider still gets killed on
its own schedule; the grace window only changes what happens when the *client* disappears while
the provider is still healthy.

**`RESUME_GRACE_MS` (15s) is a judgment call, not a measurement, and is recorded as such rather
than dressed up as one.** The plan that specified this work pointed at `bench/BASELINE.md`'s
turn-duration numbers as the source to derive it from; those numbers turned out to come from a
load test against the mock provider (a 15ms/chunk artificial delay) dominated by database and
rate-limit overhead, not real model latency — they don't actually answer "how long is worth paying
for an abandoned connection." No real-provider generation-duration distribution exists anywhere in
this repo; `FIRST_CHUNK_TIMEOUT_MS`/`STREAM_IDLE_TIMEOUT_MS` (docs/adr/0023) are themselves stated
engineering judgment, not measurements. `RESUME_GRACE_MS` is set to the same order of magnitude as
those two — long enough to plausibly survive a lock-screen or tunnel drop, short enough to bound
what an abandoned tab costs — and should be revisited once real provider-latency data exists
(`src/lib/providers/constants.ts`'s doc comment says so directly).

**Only takes effect once streaming has actually begun.** A disconnect during the pre-fetch phase
(before `attemptFirstChunk` succeeds) still aborts immediately, exactly as before this existed —
the client can't have a `requestId` to resume with yet, since response headers (which carry
`x-request-id`) are only sent once the `ReadableStream` is actually constructed, which only
happens after the first chunk is confirmed. Continuing to pay for generation nobody could ever
reconnect to would be pure waste.

**Why Redis and not Postgres for the buffer.** The buffer is short-lived (a TTL of 120s — comfortably
longer than the grace window plus margin, short enough that it never becomes durable state),
high-churn (written on a throttle, not per-token, but still far more write-heavy than anything else
in this app's Postgres tables), and disposable if lost (docs/adr/0035's whole framing: Redis is
never authoritative here, and resume being unavailable without it is an accepted, named
degradation, not a silent one). That's the shape of state ADR 0035 already established Redis is
for, and Postgres would mean either a table that's mostly churn and TTL logic hand-rolled in SQL,
or accepting write latency this doesn't need to pay.

**The first write to a resume buffer always flushes, bypassing the normal throttle
(`src/lib/streaming/resumeBuffer.ts`).** Writes are batched — every 8 events or 500ms, not per
token, so a network round trip never sits in the token loop — but if the *very first* event
followed that same throttle, a disconnect landing inside that first window would 404 on resume
even though the generation had genuinely, verifiably started. The fix costs nothing in the steady
state (one extra Redis write per generation, not per chunk) and closes an otherwise-real gap
between "a buffer conceptually exists" and "a buffer is actually readable."

**Cap the buffer's stored text, independent of what a still-connected client sees.**
`MAX_RESUME_BUFFER_CHARS` (20,000, a generous multiple of what `MAX_OUTPUT_TOKENS` already bounds
real output to) stops recording further chunk text into the buffer once crossed — terminal
(`done`/`error`) events are always recorded regardless, since they're small and fixed-size. This
never affects the live stream to a connected client (the cap only gates what's mirrored into
Redis); it's a backstop against a bug or a misbehaving provider, not a limit expected to bind on
any real generation.

**Why `requestId` alone is not authorization, and how the resume buffer closes that.** A
`requestId` travels in a plain response header today — nothing about it is a secret. The resume
buffer is bound to the same admission identity (`user:<id>` or `guest:<ip>`, matching
`route.ts`'s existing `admissionIdentity`) at creation and re-checked on every read
(`readResumeBuffer`). A missing buffer and one that belongs to someone else are made
indistinguishable on purpose — both return 404, never a 403 that would confirm a given id exists —
the same posture ADR 0009/0011 already established for story ownership checks and registration
responses.

**The resume endpoint (`GET /api/generate/[requestId]/resume`) replays buffered events after
`Last-Event-ID`, then polls for more.** Upstash's Redis client speaks HTTP, not a wire-level
pub/sub protocol a serverless function can cheaply hold open, so "tell me when there's more" is a
short poll (300ms) against the same buffer, not a message bus — a message bus would be real
infrastructure for a recovery path that is, by design, rare. The poll is bounded (`MAX_WAIT_MS`,
50s, comfortably under this route's own 60s `maxDuration`) and emits the same heartbeat comment
lines during a long wait. A second reconnect after that bound elapses is safe: reading the buffer
is idempotent, and `Last-Event-ID` just picks up from wherever the previous resume attempt left
off.

**Client-side: resume is tried once, only on a genuine transport failure, before falling back to
the existing generic error.** `streamGeneration.ts` distinguishes three outcomes from reading a
framed response: a clean `done` or `error` frame (the server told us definitively what happened —
resuming would just replay the same terminal state), a genuine local abort (`signal.aborted` —
silence, not an error, unchanged from before), and a transport failure (the reader threw for any
other reason, or the stream closed without ever reaching a terminal frame). Only the last case
attempts a resume — and only when the response carried an `x-request-id` to resume with — because
it's the only case where the client doesn't already know the outcome. Resume is tried *before* the
existing single silent auto-retry in `StoryContext.tsx` because it doesn't re-spend tokens; if
resume also fails, the same `kind: "stream-aborted"` surfaces as before this plan, and
`StoryContext.tsx` needed no changes at all — its retry-once behavior already keys off that exact
string.

## Rejected

- **Continuing generation regardless of Redis availability.** Would mean paying for every
  abandoned request indefinitely with no way to ever hand the result back — the grace window's
  entire premise is that there's a place to put the result for later pickup.
- **A message bus / pub-sub layer for "live" resume delivery.** Real infrastructure for a rare
  recovery path; a short poll against the same Redis buffer already used for storage is simpler
  and costs nothing extra to operate.
- **Deriving `RESUME_GRACE_MS` from `bench/BASELINE.md` as originally instructed.** That data
  doesn't measure what it would need to; using it anyway would have manufactured false precision
  around a fundamentally guessed number.

## Consequences

- **Named limits, not silently accepted ones:** no resume without Redis configured (falls back to
  today's immediate-abort behavior, verified by its own test); none across a server restart (a
  Redis-backed buffer plus a live producer means a restart mid-generation still loses the tail —
  the buffer alone was never going to survive that, and nothing in this plan claims otherwise);
  none cross-device or cross-session (the buffer is bound to one identity, not shareable by
  design).
- This is the first half of a future move toward a queue/worker model for generation (named, not
  built, in `docs/plans/v4/04-streaming-protocol-v2.md`'s Out of scope) — the resume buffer proves
  that generation state can survive independently of any one request's lifetime, which is the
  prerequisite for that migration, not the migration itself.
- `src/lib/ratelimit/policy.ts` gained `RESUME_GUEST`/`RESUME_USER` and `guard.ts` gained
  `guardResume` — the resume endpoint is a new unauthenticated-reachable route, and every other
  route in this app is rate-limited; leaving this one the sole exception would be a gap worth
  flagging on review rather than a deliberate omission, so it isn't one. Generous relative to
  `GENERATE_GUEST`/`GENERATE_USER` (this is a cheap Redis read behind a recovery path, not a paid
  provider call on the golden path).
