# 3. Streaming wire protocol

## Status

Accepted.

## Context

US-5 requires AI paragraphs to stream in as they're generated, not appear after a blocking wait. Next.js 16's App Router Route Handlers support this natively via a `ReadableStream` returned from a `Response` — but two problems needed solving beyond the bare pattern:

1. **Clean error surfacing.** The obvious implementation — `return new Response(stream)` immediately, before any provider output exists — commits to a `200 OK` before knowing whether the provider call will even succeed. A bad API key or an invalid model name would then surface as a broken, truncated stream on the client instead of a clean error status.
2. **Carrying `InventedMetadata` (see [ADR 1](0001-model-agnostic-provider-interface.md)) to the client.** UC-3's invented theme/characters need to reach the browser, but the interface only streams prose plus one out-of-band return value once the generator finishes — there's no separate response channel for it, and adding one (e.g. a second HTTP response, or switching to a structured framing like SSE) would complicate every other call that has no metadata to send.

## Decision

**Pre-fetch the first chunk before opening the stream.** `src/app/api/generate/route.ts` calls `iterator.next()` once, synchronously within the request handler, before constructing the `ReadableStream`. If that first call throws (bad key, invalid model, provider outage), the route returns a clean `502` with a JSON error body instead of ever starting the stream. Only once the first chunk is confirmed does the handler open the `ReadableStream` and enqueue it, then continue pulling subsequent chunks in the stream's `pull()` callback.

**Plain `text/plain` chunked streaming, not Server-Sent Events.** The response is one continuous string of prose, not a sequence of typed events — SSE's event/data framing exists to multiplex multiple event types over one connection, which this route doesn't need.

**A trailing sentinel for metadata.** When (and only when) the generator's return value is a non-empty `InventedMetadata`, the very last bytes written to the stream — after all prose, immediately before closing — are the literal string `"\n FABULA:METADATA "` followed by `JSON.stringify(metadata)`. When no metadata exists, the stream is pure prose with no sentinel, ever. Because the sentinel is guaranteed to be the final content written, a client-side consumer never needs to look for prose *after* it — once found, everything remaining is metadata JSON. The client (`src/lib/story/streamGeneration.ts`) uses a streaming-substring holdback (checking, on each new chunk, whether the buffered tail could still be an incomplete prefix of the sentinel) so the raw sentinel text can never flash on screen even if it arrives split across multiple network reads or coalesced with prose — a real possibility, since nothing above the TCP layer guarantees a server-side `enqueue()` call maps to exactly one client-side `read()`.

## Consequences

- A provider failure before any output is generated is indistinguishable to the client from any other clean HTTP error (`502`), never a mysteriously truncated stream.
- A provider failure *after* streaming has started still has to abort a committed `200` response (`controller.error()`); the client must treat a stream that ends abnormally mid-read as its own error case, which it does — see [ADR 7](0007-client-state-architecture.md) for the client-side auto-retry behavior this drives.
- The sentinel protocol is a hand-rolled convention rather than a standard framing format (SSE, NDJSON). This was an explicit tradeoff: metadata is needed on at most one call per story (the true zero-input kickoff), so a bespoke last-bytes marker avoids restructuring every other call's response just to accommodate a rare case. If more structured out-of-band data is ever needed on more than this one call, revisit in favor of a real framing protocol rather than extending the sentinel convention further.
