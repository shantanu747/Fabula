# 42. Framed streaming protocol

## Status

Accepted. Supersedes [ADR 3](0003-streaming-wire-protocol.md).

## Context

ADR 0003's wire protocol is `text/plain` prose with invented metadata appended after a
`"\n FABULA:METADATA "` sentinel, once the generator's return value is non-empty. That ADR's own
Consequences section named two structural problems this record exists to fix.

**A mid-stream failure had no representation on the wire.** Once the first chunk was sent, the
response was committed to `200`, and the only way to signal a later failure was
`controller.error(err)` — an abnormally terminated body. The client's `reader.read()` threw and
was mapped to a generic `kind: "stream-aborted"`, indistinguishable from a dropped Wi-Fi
connection or a server crash. The route's response to that ambiguity was to refuse a provider
switch mid-stream entirely (docs/adr/0023) — a correct decision given a protocol that couldn't
carry the reason, but a limitation the wire format imposed rather than the problem itself.

**The sentinel was in-band signalling.** Metadata was delimited by a magic string inside the same
byte stream as model output, so the client had to run a prefix-holdback scan on every chunk
(`longestSentinelPrefixOverlap`) to avoid painting a partial sentinel on screen. That machinery
existed purely to compensate for the framing choice.

Separately, this plan is the prerequisite for resume (docs/adr/0043): a client that reconnects
needs distinct event types to know what's already happened (prose delivered, metadata assigned,
whether the paragraph was persisted) versus what's still to come.

Spec: `docs/plans/v4/04-streaming-protocol-v2.md`.

## Decision

**Server-Sent Events, not a bespoke length-prefixed format, and not WebSockets.** SSE has a
defined grammar, is plain text (existing E2E/eval tooling stays readable), and gives resume the
standard `Last-Event-ID` reconnection mechanism it needs anyway — building a bespoke framing would
mean re-inventing that. WebSockets were rejected: the transport is one-directional and
request-scoped (the client never sends anything after its initial POST), and a socket would add
connection-management complexity for nothing this route needs.

**Five event types, each carrying a monotonic `id`:**

| Event | Payload | Notes |
|---|---|---|
| `chunk` | `{ text }` | a prose delta; nothing else ever appears on this channel |
| `meta` | `{ invented? }` | replaces the sentinel entirely; always sent once, whether or not the provider invented anything |
| `usage` | `{ model, inputTokens?, outputTokens?, cache* }` | sent once, before `done` |
| `error` | `{ kind, message, retryable, suggestedProviderId?, suggestedProviderName? }` | valid at any point, including mid-stream |
| `done` | `{ position?, storyId?, persisted }` | terminal, normal close |

`src/lib/streaming/protocol.ts` is the one place the encoder and the incremental parser live,
shared verbatim by `route.ts` and `streamGeneration.ts` so the two sides cannot drift. The parser
buffers across `push()` calls rather than assuming one network read maps to one complete frame —
network fragmentation can split a frame at any byte boundary, including exactly on the blank line
that terminates it. `protocol.test.ts` fuzzes this with `fast-check`: the same encoded byte
sequence, fed to the parser in randomly-chosen chunk splits (including one-byte-at-a-time), must
always produce the identical event sequence. `JSON.stringify` is what actually makes this safe —
it never emits a literal newline (an embedded `\n` in prose becomes the two-character escape
`\n`), so a chunk's `data:` line is always exactly one line no matter what the prose contains,
including text that itself contains `\n\n`, the literal string `"data:"`, or the old sentinel.

**A mid-stream failure is now a typed `error` frame on a normally-terminated stream.**
`route.ts`'s generation-driving loop catches a provider failure or idle-timeout stall, emits
`{ kind: "stream-aborted", message: "...", retryable: true }`, and then closes the stream
normally — `controller.close()`, not `controller.error()`. The client-facing `kind` stays
`"stream-aborted"` deliberately: `StoryContext.tsx`'s existing single silent auto-retry
(docs/adr/0023) already keys off that exact string, and this plan doesn't touch that file — the
wire representation changes from "abrupt broken stream the client has to infer meaning from" to
"an honest, explicit frame," while the client-visible *value* and its retry behavior are
unchanged. `suggestedProviderId`/`suggestedProviderName` are never populated on a mid-stream error
frame, even though the payload shape allows it — ADR 0023 rule 3 (never offer a provider switch
once prose has streamed) still stands; only the pre-stream 502 path populates a suggestion.

**The generation-driving loop is no longer gated by `ReadableStream.pull()`.** The old
`start()`/`pull()` split relied on the platform calling `pull()` again only once the consumer had
drained the internal queue — a real backpressure mechanism, but one with no actual cost benefit
here (the provider keeps generating regardless of how fast the browser reads) and one that cannot
survive a client disconnect: once the consumer is gone, `pull()` never fires again, and nothing
would drive the iterator forward during a resume grace window (docs/adr/0043). `route.ts` now runs
one continuous async function (`driveGeneration`) from `start()`, calling `iterator.next()` in a
plain loop and pushing to the controller as data arrives, with an `emit()` helper that also
mirrors every frame into the resume buffer when one exists. This is a behavior change existing
tests had to account for: several disconnect-simulation tests previously relied on `pull()`'s
consumer-paced timing to create a "genuinely mid-stream" moment using a plain, no-delay fake
generator; under the new self-driving loop such a fake can run to completion before the test ever
calls `reader.cancel()`. Those tests now use the existing `stallAfterChunks` fake (which
genuinely blocks on its next `.next()` call pending an abort signal) instead, which is
robust regardless of the consumption model.

**A comment/heartbeat line during long provider silences.** `: heartbeat\n\n` every 15s
(`HEARTBEAT_INTERVAL_MS`, well under `STREAM_IDLE_TIMEOUT_MS`'s 30s), so an intermediary doesn't
mistake an idle-but-alive stream for a dead one. Comment lines are part of the SSE grammar and are
silently skipped by the parser.

**`done.persisted` makes expressible what ADR 0022's silently-swallowed persistence failures could
not.** Today the server distinguishes `"superseded"`/`"failed"` internally but always returns a
clean stream, so the client commits the paragraph locally regardless and the database mirror can
silently diverge. The framed protocol carries `persisted: boolean` (plus `position`/`storyId` when
applicable) on `done` — this plan only makes it expressible on the wire; `streamGeneration.ts`
parses it but doesn't yet act on it (nothing in `StreamCallbacks` surfaces it to the UI). A future
plan is what's expected to consume it.

**Kept unchanged, deliberately:** the pre-fetch-first-chunk behavior (`route.ts` still calls
`iterator.next()` once before ever constructing the stream, so a bad key or invalid model still
surfaces as a clean 502 JSON body — the 502 is what lets the route retry once and what the
failover UI reads) and `x-request-id` on every response.

## Rejected

- **A bespoke length-prefixed framing.** SSE already has a defined grammar and the
  `Last-Event-ID` mechanism resume needs; a custom format would have to reinvent both for no
  benefit.
- **WebSockets.** The transport is one-directional and request-scoped; a full-duplex socket adds
  connection-management complexity this route never needs.
- **Populating `suggestedProviderId` on a mid-stream `error` frame.** The payload shape allows it,
  but doing so would silently reopen ADR 0023 rule 3 (no provider switch mid-paragraph).

## Consequences

- A parser to maintain (`src/lib/streaming/protocol.ts`, held at 100% coverage —
  `src/lib/streaming/**` is a new tier in `vitest.config.mts`, alongside `kv`/`admission`/`budget`:
  a wrong parse here is exactly the "subtle, expensive to get wrong" shape those already share) and
  a wire format to version — unknown event types are ignored forward-compatibly by construction
  (`KNOWN_EVENT_TYPES`), so a future event type can be added without breaking an older client mid-
  rollout.
- `route.ts`'s own coverage tier (90/85/90/90, not 100%) still applies, and still has to for the
  same reason ADR 0023 named: a couple of defensive branches (an `enqueue()`/`close()` racing a
  disconnect between a `clientGone` check and the call itself) are reachable only by a platform-
  level race a synthetic unit test can't cleanly force.
- Every consumer of `/api/generate`'s response body that assumed raw prose had to change:
  `streamGeneration.ts` (rewritten — see docs/adr/0043 for the resume half), `bench/harness.ts`
  (decodes frames instead of raw text for its TTFT/prose measurement), and every test asserting on
  response bodies in `route.test.ts`/`route.db.test.ts` (now parsed via a shared
  `src/test/sse.ts` helper). `evals/`'s fixtures did **not** need re-recording — verified, not
  assumed: the eval harness replays **raw vendor SSE** (Anthropic/OpenAI's own wire format) through
  the real provider adapters, a layer entirely upstream of and unaffected by this route's own
  client-facing framing.
