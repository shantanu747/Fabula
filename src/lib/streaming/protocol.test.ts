import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SSEStreamParser,
  encodeHeartbeat,
  encodeStreamEvent,
  type StreamEvent,
} from "./protocol";

function parseAll(text: string): ReturnType<SSEStreamParser["push"]> {
  return new SSEStreamParser().push(text);
}

/** Splits `text` at the given 0-based indices (sorted, deduped, clamped),
 *  producing the pieces a `push()` sequence would be fed. */
function splitAt(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map((c) => Math.max(0, Math.min(text.length, c))))].sort((a, b) => a - b);
  const pieces: string[] = [];
  let last = 0;
  for (const p of points) {
    pieces.push(text.slice(last, p));
    last = p;
  }
  pieces.push(text.slice(last));
  return pieces;
}

const sampleEvents: StreamEvent[] = [
  { event: "chunk", data: { text: "Once upon a time, " } },
  { event: "chunk", data: { text: "there was a dragon." } },
  { event: "meta", data: { invented: { theme: "noir", characters: "a detective" } } },
  { event: "usage", data: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 91 } },
  { event: "done", data: { persisted: true, position: 3, storyId: "story-1" } },
];

describe("encodeStreamEvent / SSEStreamParser — round trip", () => {
  it("parses a full encoded sequence back into the same events, in order, with ids", () => {
    let id = 1;
    const encoded = sampleEvents.map((e) => encodeStreamEvent(id++, e)).join("");

    const frames = parseAll(encoded);

    expect(frames).toHaveLength(sampleEvents.length);
    frames.forEach((frame, i) => {
      expect(frame.id).toBe(i + 1);
      expect(frame.event).toEqual(sampleEvents[i]);
    });
  });

  it("ignores heartbeat comment lines interleaved between frames", () => {
    const encoded = encodeHeartbeat() + encodeStreamEvent(1, sampleEvents[0]) + encodeHeartbeat() + encodeStreamEvent(2, sampleEvents[1]);

    const frames = parseAll(encoded);

    expect(frames).toEqual([
      { id: 1, event: sampleEvents[0] },
      { id: 2, event: sampleEvents[1] },
    ]);
  });

  it("ignores an unknown event type but keeps parsing forward-compatibly", () => {
    const encoded = "id: 1\nevent: future-event\ndata: {\"whatever\":true}\n\n" + encodeStreamEvent(2, sampleEvents[0]);

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 2, event: sampleEvents[0] }]);
  });

  it("joins multiple data: lines with a newline before parsing, per the SSE spec", () => {
    // JSON grammar allows whitespace (including a bare newline) between a
    // colon and its value, so this is valid JSON once the two `data:` lines
    // are joined with "\n" — which only happens if both lines were actually
    // read, not just the first.
    const encoded = 'id: 1\nevent: chunk\ndata: {"text":\ndata: "hello"}\n\n';

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 1, event: { event: "chunk", data: { text: "hello" } } }]);
  });

  it("round-trips a chunk whose text contains \\n\\n, 'data:', and the old sentinel string", () => {
    const tricky: StreamEvent = {
      event: "chunk",
      data: { text: 'line one\n\nline two with data: embedded and \n FABULA:METADATA {"fake":true}' },
    };
    const encoded = encodeStreamEvent(1, tricky);

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 1, event: tricky }]);
  });

  it("drops a frame with malformed JSON in data rather than throwing", () => {
    const encoded = "id: 1\nevent: chunk\ndata: not json\n\n" + encodeStreamEvent(2, sampleEvents[0]);

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 2, event: sampleEvents[0] }]);
  });

  it("tolerates a field with no colon at all, and no leading space after one", () => {
    // "id" alone (no colon: field is the whole line, value is "") and
    // "event:done" (no space before the value) are both valid per the SSE
    // field-line grammar, even though this module's own encoder never
    // produces either shape.
    const encoded = "id\nevent:done\ndata:{\"persisted\":true}\n\n";

    const frames = parseAll(encoded);

    // The empty "id" line never set an id (empty value, not a number), so the
    // frame carries no id at all.
    expect(frames).toEqual([{ id: undefined, event: { event: "done", data: { persisted: true } } }]);
  });

  it("ignores a non-numeric id field, leaving the frame's id unset", () => {
    const encoded = "id: not-a-number\nevent: done\ndata: {\"persisted\":false}\n\n";

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: undefined, event: { event: "done", data: { persisted: false } } }]);
  });

  it("treats an empty data field as no payload, decoding to undefined data", () => {
    const encoded = "id: 1\nevent: done\ndata:\n\n";

    const frames = parseAll(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(1);
    expect(frames[0].event.event).toBe("done");
    expect(frames[0].event.data).toBeUndefined();
  });

  it("tolerates CRLF line endings", () => {
    const encoded = "id: 1\r\nevent: chunk\r\ndata: {\"text\":\"hi\"}\r\n\r\n";

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 1, event: { event: "chunk", data: { text: "hi" } } }]);
  });

  it("ignores an entirely unrecognised field name", () => {
    const encoded = "retry: 3000\nid: 1\nevent: chunk\ndata: {\"text\":\"hi\"}\n\n";

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 1, event: { event: "chunk", data: { text: "hi" } } }]);
  });

  it("drops a dispatched block with fields but no event: line, rather than defaulting to a known type", () => {
    // Falls back to the SSE spec's default event name "message" internally,
    // which — correctly — isn't one of this protocol's known types, so the
    // frame is dropped rather than silently misidentified.
    const encoded = "id: 1\ndata: {\"text\":\"hi\"}\n\n" + encodeStreamEvent(2, sampleEvents[0]);

    const frames = parseAll(encoded);

    expect(frames).toEqual([{ id: 2, event: sampleEvents[0] }]);
  });
});

describe("SSEStreamParser — arbitrary chunk boundaries (property test)", () => {
  const arbitraryText = fc.string({ minLength: 0, maxLength: 40 });
  const arbitraryChunkEvent = arbitraryText.map((text): StreamEvent => ({ event: "chunk", data: { text } }));
  const arbitraryMetaEvent = fc
    .option(fc.record({ theme: arbitraryText, characters: arbitraryText }), { nil: undefined })
    .map((invented): StreamEvent => ({ event: "meta", data: { invented: invented ?? undefined } }));
  const arbitraryDoneEvent = fc
    .record({ persisted: fc.boolean(), position: fc.option(fc.nat(50), { nil: undefined }) })
    .map((data): StreamEvent => ({ event: "done", data }));
  const arbitraryEvent = fc.oneof(arbitraryChunkEvent, arbitraryMetaEvent, arbitraryDoneEvent);

  it("produces an identical event sequence no matter how the encoded bytes are split", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryEvent, { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(500), { minLength: 0, maxLength: 20 }),
        (events, cutPoints) => {
          let id = 1;
          const encoded = events.map((e) => encodeStreamEvent(id++, e)).join("");
          const expected = events.map((e, i) => ({ id: i + 1, event: e }));

          // Baseline: fed as one piece.
          expect(parseAll(encoded)).toEqual(expected);

          // The actual property: fed in arbitrarily-split pieces, a fresh
          // parser accumulating across push() calls sees the same sequence.
          const parser = new SSEStreamParser();
          const pieces = splitAt(encoded, cutPoints);
          const collected = pieces.flatMap((piece) => parser.push(piece));
          expect(collected).toEqual(expected);
        }
      )
    );
  });

  it("splits at every single byte boundary (the sharpest case) for one representative sequence", () => {
    let id = 1;
    const events = sampleEvents;
    const encoded = events.map((e) => encodeStreamEvent(id++, e)).join("");
    const expected = events.map((e, i) => ({ id: i + 1, event: e }));

    const parser = new SSEStreamParser();
    const collected = encoded.split("").flatMap((ch) => parser.push(ch));

    expect(collected).toEqual(expected);
  });
});
