import type { InventedMetadata } from "@/lib/providers/types";
import type { GenerationErrorKind } from "@/lib/story/types";

/**
 * The framed wire protocol for `/api/generate` and its resume endpoint
 * (docs/adr/0042, superseding docs/adr/0003's sentinel). Pure, no I/O — the
 * encoder and parser are shared verbatim by server (`route.ts`) and client
 * (`streamGeneration.ts`) so the two sides cannot drift apart.
 *
 * Server-Sent Events, not a bespoke framing: SSE has a defined grammar, the
 * `Last-Event-ID` mechanism resume needs anyway, and stays plain text so
 * existing E2E/eval tooling remains readable.
 */

export interface ChunkEventData {
  text: string;
}

export interface MetaEventData {
  invented?: InventedMetadata;
}

export interface UsageEventData {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ErrorEventData {
  kind: GenerationErrorKind;
  message: string;
  retryable: boolean;
  /** Only ever set on a pre-stream provider failure — never mid-stream, so a
   *  provider switch is never implicitly offered once prose has streamed
   *  (docs/adr/0023 rule 3). */
  suggestedProviderId?: string;
  suggestedProviderName?: string;
}

export interface DoneEventData {
  position?: number;
  storyId?: string;
  persisted: boolean;
}

export type StreamEvent =
  | { event: "chunk"; data: ChunkEventData }
  | { event: "meta"; data: MetaEventData }
  | { event: "usage"; data: UsageEventData }
  | { event: "error"; data: ErrorEventData }
  | { event: "done"; data: DoneEventData };

export type StreamEventType = StreamEvent["event"];

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<StreamEventType>([
  "chunk",
  "meta",
  "usage",
  "error",
  "done",
]);

/**
 * One SSE frame, always `id: N`, `event: <type>`, `data: <json>`, blank line.
 * JSON.stringify never emits a literal newline (embedded `\n` in prose becomes
 * the two-character escape `\n`), so `data` is always exactly one line no
 * matter what the event payload contains — including text that itself
 * contains `\n\n`, `data:`, or the old sentinel string.
 */
export function encodeStreamEvent(id: number, event: StreamEvent): string {
  return `id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** A comment line, ignored by any SSE parser — keeps intermediaries from
 *  timing out an idle-but-alive connection during a long provider silence. */
export function encodeHeartbeat(): string {
  return ": heartbeat\n\n";
}

export interface DecodedFrame {
  id?: number;
  event: StreamEvent;
}

interface RawFrame {
  id?: number;
  event: string;
  data: string;
}

/**
 * Incremental SSE line parser. Network fragmentation can split an encoded
 * frame at any byte boundary — mid-field, mid-value, or exactly on the blank
 * line that terminates it — so this buffers across `push()` calls rather than
 * assuming one `push()` maps to one complete frame. Only `\n`-terminated
 * lines are produced by this module's own encoder; a trailing `\r` is
 * stripped defensively but CR-only line endings are not otherwise supported,
 * since nothing in this codebase emits them.
 */
export class SSEStreamParser {
  private buffer = "";
  private currentId: number | undefined;
  private currentEvent: string | undefined;
  private currentDataLines: string[] = [];
  private sawField = false;

  /** Feeds raw decoded text (already UTF-8 decoded) into the parser, returning
   *  any frames completed by this call. Partial trailing data is buffered for
   *  the next call. */
  push(text: string): DecodedFrame[] {
    this.buffer += text;
    const raw: RawFrame[] = [];

    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.consumeLine(line, raw);
    }

    const frames: DecodedFrame[] = [];
    for (const r of raw) {
      const decoded = decodeRawFrame(r);
      if (decoded) frames.push(decoded);
    }
    return frames;
  }

  private consumeLine(rawLine: string, out: RawFrame[]): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line === "") {
      if (this.sawField) {
        out.push({ id: this.currentId, event: this.currentEvent ?? "message", data: this.currentDataLines.join("\n") });
      }
      this.currentId = undefined;
      this.currentEvent = undefined;
      this.currentDataLines = [];
      this.sawField = false;
      return;
    }

    // Comment/heartbeat line — the SSE spec's ":..." field, silently ignored.
    if (line.startsWith(":")) return;

    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1); // one leading space is part of the field syntax, not the value

    if (field === "id") {
      const n = Number(value);
      if (!Number.isNaN(n) && value.trim() !== "") this.currentId = n;
      this.sawField = true;
    } else if (field === "event") {
      this.currentEvent = value;
      this.sawField = true;
    } else if (field === "data") {
      this.currentDataLines.push(value);
      this.sawField = true;
    }
    // Unknown fields (e.g. "retry") are ignored — forward-compatible by construction.
  }
}

function decodeRawFrame(raw: RawFrame): DecodedFrame | undefined {
  if (!KNOWN_EVENT_TYPES.has(raw.event)) return undefined; // unknown event type, ignored forward-compatibly
  let data: unknown;
  try {
    data = raw.data === "" ? undefined : JSON.parse(raw.data);
  } catch {
    return undefined;
  }
  return { id: raw.id, event: { event: raw.event, data } as StreamEvent };
}
