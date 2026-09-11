# Plan 4 — Streaming protocol v2: framed events and resume

**Branch:** `feature/streaming-protocol-v2`
**Depends on:** Plan 2 (Redis, for the resume buffer). Land after Plan 3 — both make heavy edits to
`src/app/api/generate/route.ts` and doing them in parallel guarantees a painful merge. *If Plan 2
isn't merged yet:* build the framed protocol, which needs nothing new, and gate resume behind
`hasKv()` so it is inert without Redis.
**ADRs:** two — the framed protocol (superseding ADR 0003), and resume.

## Why this exists

ADR 0003's wire protocol is `text/plain` prose with invented metadata appended after a
`"\n FABULA:METADATA "` sentinel. It has two structural problems its own Consequences section
already admits.

**1. A mid-stream failure has no representation.** Once the first chunk has been sent, the response
is committed to 200 and the only way to signal failure is `controller.error(err)`
(`route.ts:488`) — an abnormally terminated body. The client's `reader.read()` throws and is mapped
to a generic `kind: "stream-aborted"` (`streamGeneration.ts:145-153`). The client therefore cannot
distinguish a provider failure from a dropped Wi-Fi connection from a server crash, and cannot be
told whether retrying would help. The route's response to that ambiguity is to refuse a provider
switch mid-stream entirely (`route.ts:476-480`) — a correct decision given a protocol that cannot
carry the reason, but a limitation imposed by the wire format rather than by the problem.

**2. The sentinel is in-band signalling.** Metadata is delimited by a magic string inside the same
byte stream as model output, so the client must run a prefix-holdback scan
(`streamGeneration.ts:34-40, 115-137`) to avoid painting a partial sentinel on screen. That
machinery exists purely to compensate for the framing choice, and a model that emits the sentinel
text is still treated as a real metadata boundary.

Separately: a client that disconnects loses the paragraph entirely. The tokens are paid for, the
generation may complete server-side, and the user gets nothing. There is no resume.

## What "done" means

- The response is a framed event stream; prose, metadata, usage, errors, and completion are
  distinct event types.
- A mid-stream provider failure arrives as a typed `error` event with a `kind` and a `retryable`
  flag, on a normally-terminated stream.
- The `FABULA:METADATA` sentinel and the client's holdback scan are **deleted**, not kept alongside.
- A client that reconnects within a grace window receives the text generated while it was away and
  continues live.
- With no Redis, resume is unavailable and everything else works unchanged.

## The protocol

Server-Sent Events (`text/event-stream`). Not a bespoke length-prefixed format: SSE has a defined
grammar, a standard `Last-Event-ID` reconnection mechanism that the resume half needs anyway, and
is plain text so the existing E2E and eval tooling stays readable. Not WebSockets: the transport is
one-directional and request-scoped, and a socket would add connection management for nothing.

Event types:

| Event | Payload | Notes |
|---|---|---|
| `chunk` | `{ text }` | a prose delta. Nothing else ever appears on this channel |
| `meta` | `{ invented? }` | replaces the sentinel entirely |
| `usage` | `{ model, inputTokens?, outputTokens?, cache* }` | sent once before `done` |
| `error` | `{ kind, message, retryable, suggestedProviderId?, suggestedProviderName? }` | valid **at any point**, including mid-stream |
| `done` | `{ position?, storyId?, persisted }` | terminal, normal close |

Every event carries an SSE `id` — a monotonic sequence number within the generation — which is what
`Last-Event-ID` resumes from.

Note what this fixes beyond error reporting: `done` can now tell the client whether the paragraph was
actually **persisted**. Today the server swallows `"superseded"` and `"failed"`
(`route.ts:406-419`) and returns a clean stream, so the client commits the paragraph locally
regardless and the mirror can silently diverge. The framed protocol makes that state expressible;
Plan 5 uses it.

Keep `x-request-id` on the response. Keep the pre-fetch-the-first-chunk behaviour
(`route.ts:285-310`) — a pre-stream failure should still be a clean 502 rather than a 200 carrying
an `error` frame, because the 502 is what lets the *route* retry once and what the failover UI reads.

## The resume tradeoff — the substance of the second ADR

Today, client disconnect aborts the provider call immediately (`route.ts:264-265`). That is a
deliberate cost saving: an abandoned tab stops spending money.

**Resume is incompatible with that**, because there is nothing to resume to if generation stopped
when the socket closed. The resolution is a bounded grace window: on disconnect, keep generating for
at most `RESUME_GRACE_MS`, then abort. The ADR must state the cost of that window in plain terms —
"we pay up to N seconds of generation for every abandoned request, in exchange for not losing a
paragraph across a tunnel or a lock screen" — and note that a mobile co-writing session (a stated
persona) drops connections often enough to make that trade worth it.

Pick the window from the real distribution of generation durations in `bench/BASELINE.md`, not by
guessing.

## Files

### `src/lib/streaming/protocol.ts` (new)

The event types, the encoder, and the parser, shared by server and client so they cannot drift.
Pure, no I/O, easy to hold at **100% coverage** — put it in that tier.

The parser must be a proper incremental SSE parser: events split across arbitrary chunk boundaries,
multi-line `data:` fields, `id:` fields, and comment/heartbeat lines. Naive `split("\n\n")` on each
chunk is the classic bug here, and it only shows up under real network fragmentation — which is
exactly when it matters. Property-test it with `fast-check` (already a dependency) by feeding the
same byte sequence in randomly-chosen chunk splits and asserting an identical event sequence.

Include a heartbeat comment line during long provider silences, so intermediaries do not time out an
idle-but-alive stream.

### `src/app/api/generate/route.ts` (modify)

Emit frames instead of raw text. The existing five-terminal-path discipline (ADR 0022, guarded by
`finishedOnce` at `:372-378`) now has a third resource to manage alongside the span and Plan 2's
lease: the resume buffer. **All three release in the same latch.** Do not add a fourth lifetime
mechanism.

Replace `controller.error(err)` with an `error` frame followed by a normal close — a
normally-terminated stream carrying a typed error is the entire point. Keep `controller.error` only
for the case where the frame itself cannot be written.

`src/app/api/generate/**` is at 90/85/90/90 coverage; the new branches need tests.

### `src/lib/streaming/resumeBuffer.ts` (new)

Accumulated text plus the last event id, keyed by `requestId` in Redis with a short TTL, written on
a throttle (every N chunks or M milliseconds — not per token, which would put a network round trip
in the token loop).

Cap the buffer at the maximum plausible paragraph size. It is attacker-influenced storage and needs
a bound.

### `src/app/api/generate/[requestId]/resume/route.ts` (new)

`GET` with `Last-Event-ID`. Returns the frames after that id: the buffered text, then live frames if
the generation is still running, or the remaining frames plus `done` if it finished.

**Authorization matters here.** A `requestId` is not a capability. Bind the buffer to the session
(or to the guest identity) at creation and verify on resume, or one user's `requestId` — which
travels in a response header today — reads another's paragraph. Test this directly.

### `src/lib/story/streamGeneration.ts` (rewrite)

Parse frames. **Delete** the holdback scan (`:34-40, 115-137`) and the sentinel constant — do not
leave them alongside the new path.

Recovery order on transport failure: attempt resume once, and only if that fails surface an error.
Keep the existing single silent retry for the genuinely-aborted case
(`StoryContext.tsx:217-220`); resume is tried first because it does not re-spend tokens.

Preserve the `signal.aborted` versus `AbortError` distinction (`:56-68`, `:145-153`) — ADR 0026
records the UI hanging "stuck streaming forever with no error" when that was conflated, and it is
easy to lose in a rewrite.

### `evals/` and `test-support/mock-provider/`

The eval harness replays recorded fixtures through the real adapters. Fixtures are **raw vendor SSE**
and the adapters are unchanged, so recordings should stay valid — **verify this rather than assuming
it**; `npm run eval` fails hard on stale fixtures by design (ADR 0018), so a break surfaces
immediately in CI. Re-record only if genuinely necessary, and say why in the PR.

## Tests

- `protocol.test.ts` — encode/parse round trip; **property test over random chunk splits**;
  multi-line data; unknown event types ignored forward-compatibly; a `chunk` whose text contains
  `\n\n`, `data:`, or a string resembling the old sentinel.
- `resumeBuffer.test.ts` — throttled writes; TTL; size cap; the session binding rejects a foreign
  `requestId`.
- `route.test.ts` — an `error` frame for a mid-stream provider failure on a normally-closed stream;
  exactly one span, one lease release, and one buffer cleanup per generation across success,
  pre-stream error, mid-stream error, and both disconnect cases.
- `streamGeneration.test.ts` — resume-then-continue; resume-fails-then-error; the abort distinction.
- E2E — mid-stream failure via `truncateResponse` shows a typed error rather than a hang; a forced
  disconnect mid-generation followed by reconnection recovers the paragraph. The mock provider's
  remote-control plane (`e2e/helpers/mock.ts`) already supports the injection.

## Verification

Full CI reproduction, plus:

- **`npm run test:e2e:soak` (~10 minutes), not a single pass.** This plan changes the streaming path
  the flakiest specs in the suite exercise. Per `AGENTS.md`: a full-suite run restarts the webServer
  each time and can pass 5/5 without proving anything.
- To hunt a specific interaction, use the targeted loop rather than the whole suite:
  `npx playwright test --config e2e/playwright.config.ts --repeat-each=15 <spec-a> <spec-b>`.
- **Do not build a failure theory on `[WebServer]` log ordering.** Playwright's webServer output and
  its reporter are separately-piped streams that interleave in flush order, not event order. ADR
  0020 is a case study in a plausible theory from that evidence shipping a wrong fix. Confirm from
  `trace.zip` / `error-context.md`, or from a real repro.
- By hand: start a generation, kill the network (devtools offline), restore it within the grace
  window, confirm the paragraph completes. Then repeat past the window and confirm a clean,
  understandable failure.
- Confirm `npm run eval` passes without re-recording, or explain why re-recording was needed.

## Gotchas

- SSE framing is easy to get subtly wrong at chunk boundaries. The property test is not optional.
- The grace window means work continues after the response closes. Ensure the platform will not kill
  the invocation first — this is what `maxDuration` (Plan 2) is for, and the grace window must fit
  inside it.
- The resume buffer is attacker-influenced storage: bound its size, TTL it, and bind it to an
  identity.
- `route.ts:264` adds an abort listener that is never removed. Plan 5 fixes the leak; do not make it
  worse here by adding more unremoved listeners.
- Anything that reads the response as plain text — E2E helpers, the bench harness — breaks. Update
  them in this branch.
- Do not let `error` frames carry provider detail. The 502 deliberately withholds cause
  (`route.ts:338-341`, ADR 0011). Frames carry a `kind`, not a stack trace.

## Out of scope

- Moving generation to a queue or worker. The resume buffer is a prerequisite for that and not the
  thing itself — name it as such in the ADR.
- WebSockets or bidirectional transport.
- Resuming across a server restart (Redis-backed buffer plus a live producer means a restart
  mid-generation still loses the tail — state this limit).
- Multi-device or cross-session resume.

## ADRs

**`docs/adr/00NN-framed-streaming-protocol.md`** — supersedes ADR 0003.

- Why framed events over the sentinel: in-band signalling forced the holdback scan and made
  mid-stream errors inexpressible.
- Why SSE over a bespoke format (defined grammar, `Last-Event-ID` needed anyway) and over
  WebSockets (one-directional, request-scoped).
- Why the pre-fetch-first-chunk 502 path is retained rather than folded into an `error` frame.
- What `done.persisted` now makes expressible that ADR 0022's silently-swallowed persistence
  failures could not.
- Consequences: a parser to maintain, a wire format to version, forward-compatible unknown events.

**`docs/adr/00NN-resumable-generation.md`**

- The tradeoff, stated in dollars: the grace window versus a lost paragraph, and why the mobile
  co-writing persona justifies it.
- Why Redis and not Postgres for the buffer (short-lived, high-churn, TTL-native — the kind of state
  that would otherwise be pure dead-tuple churn).
- Why `requestId` alone is not authorization.
- The named limits: no resume without Redis, none across a restart, none cross-device.
- Why this is the first half of a future queue/worker migration, and what would trigger finishing it.
