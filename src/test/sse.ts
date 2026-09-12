import { SSEStreamParser, type DecodedFrame, type StreamEvent } from "@/lib/streaming/protocol";

/**
 * Drains a `/api/generate` (or its resume endpoint's) framed response body
 * into the decoded event sequence, for tests that need to assert on more than
 * just the concatenated prose (docs/adr/0042).
 */
export async function readAllFrames(response: Response): Promise<DecodedFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEStreamParser();
  const frames: DecodedFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (value) frames.push(...parser.push(decoder.decode(value, { stream: true })));
    if (done) break;
  }
  return frames;
}

function isChunk(event: StreamEvent): event is Extract<StreamEvent, { event: "chunk" }> {
  return event.event === "chunk";
}

/** The concatenated prose across every `chunk` frame — the SSE-era equivalent
 *  of the old plain-text response body. */
export function chunkText(frames: DecodedFrame[]): string {
  return frames
    .map((f) => f.event)
    .filter(isChunk)
    .map((e) => e.data.text)
    .join("");
}

/**
 * The `.data` payload of every frame of the given type, in order. Typed as
 * the union of every event's data shape rather than narrowed to `T` — TypeScript's
 * `Extract<StreamEvent, {event: T}>` doesn't distribute cleanly over a bare
 * generic type parameter here — the runtime filter is what actually
 * guarantees the shape, and callers assert on it with `toEqual` (a runtime
 * check) rather than relying on static narrowing.
 */
export function framesOfType(frames: DecodedFrame[], type: StreamEvent["event"]): StreamEvent["data"][] {
  return frames
    .map((f) => f.event)
    .filter((e) => e.event === type)
    .map((e) => e.data);
}
