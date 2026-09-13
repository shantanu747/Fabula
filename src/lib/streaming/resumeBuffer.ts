import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";
import type { StreamEvent } from "./protocol";

/**
 * The Redis-backed resume buffer (docs/adr/0043): accumulated events plus the
 * last event id, keyed by `requestId`, written on a throttle so a network
 * round trip never sits in the per-chunk token loop.
 */

const RESUME_BUFFER_TTL_SECONDS = 120;

/**
 * Attacker-influenced storage needs a bound. `MAX_OUTPUT_TOKENS` (1500,
 * src/lib/providers/constants.ts) already caps real generations at roughly
 * 6,000 characters worst case (~4 chars/token) — this is a generous multiple
 * of that, a backstop against a bug or a misbehaving provider rather than a
 * limit expected to bind in the normal path.
 */
const MAX_RESUME_BUFFER_CHARS = 20_000;

/** Batches Redis writes so they cost at most one round trip per this many
 *  events or this many milliseconds, whichever comes first — never per token. */
const FLUSH_EVERY_N_EVENTS = 8;
const FLUSH_EVERY_MS = 500;

function bufferKey(requestId: string): string {
  return `resume:${requestId}`;
}

export interface ResumeBufferRecord {
  /** The admission identity (`user:<id>` or `guest:<ip>`) that created this
   *  generation — checked on resume so a requestId alone is never a capability. */
  identity: string;
  events: Array<{ id: number; event: StreamEvent }>;
  /** Set once a `done` or `error` event has been recorded — the generation has
   *  reached a terminal state and nothing further will ever be appended. */
  complete: boolean;
}

export interface ResumeBufferHandle {
  /** Records one event under the caller-assigned id (the same id already sent
   *  to a still-connected client), flushing to Redis on the throttle above (or
   *  immediately for a terminal `done`/`error` event). */
  record(id: number, event: StreamEvent): Promise<void>;
  /** Forces any unflushed events to Redis — call before a phase where nothing
   *  else will trigger a flush (e.g. right before entering a client-disconnected,
   *  buffer-only tail). */
  flush(): Promise<void>;
}

/**
 * Creates a resume buffer for one generation, or `undefined` when Redis isn't
 * configured — the single gate every caller needs. With no Redis, resume is
 * unavailable and generation proceeds exactly as it did before this existed.
 */
export async function createResumeBuffer(requestId: string, identity: string): Promise<ResumeBufferHandle | undefined> {
  if (!hasKv()) return undefined;

  const events: Array<{ id: number; event: StreamEvent }> = [];
  let pendingSinceFlush = 0;
  let lastFlushAt = Date.now();
  let charsBuffered = 0;
  let capped = false;
  let complete = false;
  let everFlushed = false;

  async function writeToRedis(): Promise<void> {
    const record: ResumeBufferRecord = { identity, events, complete };
    await withKvTimeout(() => getKv().set(bufferKey(requestId), record, { ex: RESUME_BUFFER_TTL_SECONDS }));
    everFlushed = true;
  }

  return {
    async record(id, event) {
      const isTerminal = event.event === "done" || event.event === "error";
      if (isTerminal) complete = true;

      if (event.event === "chunk") {
        if (!capped) {
          charsBuffered += event.data.text.length;
          if (charsBuffered > MAX_RESUME_BUFFER_CHARS) capped = true;
        }
        // A capped generation is never expected in practice — MAX_OUTPUT_TOKENS
        // bounds real output far below this. Dropping further chunk text from
        // the buffer here only degrades an already-degraded (bug or abuse)
        // path; the live stream to a still-connected client is untouched,
        // since this buffer is never in that path.
        if (!capped) events.push({ id, event });
      } else {
        events.push({ id, event });
      }

      pendingSinceFlush++;
      // The very first record always flushes, regardless of the throttle —
      // otherwise a disconnect inside the first FLUSH_EVERY_MS/N window would
      // 404 on resume even though the generation had genuinely started,
      // because the buffer key would not exist in Redis yet at all.
      const due =
        isTerminal || !everFlushed || pendingSinceFlush >= FLUSH_EVERY_N_EVENTS || Date.now() - lastFlushAt >= FLUSH_EVERY_MS;
      if (due) {
        await writeToRedis();
        pendingSinceFlush = 0;
        lastFlushAt = Date.now();
      }
    },
    async flush() {
      if (pendingSinceFlush > 0) {
        await writeToRedis();
        pendingSinceFlush = 0;
        lastFlushAt = Date.now();
      }
    },
  };
}

/**
 * Reads a resume buffer back, or `undefined` for a missing/expired buffer AND
 * for one that belongs to a different identity — the caller must not be able
 * to tell those two apart (same posture as ADR 0009/0011's ownership checks:
 * a requestId is not a capability on its own).
 */
export async function readResumeBuffer(requestId: string, identity: string): Promise<ResumeBufferRecord | undefined> {
  if (!hasKv()) return undefined;
  const record = await withKvTimeout(() => getKv().get<ResumeBufferRecord>(bufferKey(requestId)));
  if (!record) return undefined;
  if (record.identity !== identity) return undefined;
  return record;
}
