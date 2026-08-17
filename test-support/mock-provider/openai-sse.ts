/**
 * SSE encoder for the OpenAI chat.completions streaming format (also what
 * OpenRouter speaks), as parsed by the installed openai SDK (see
 * node_modules/openai/core/streaming.js + internal/decoders/line.js —
 * verified, not from memory).
 *
 * No `event:` line is needed (or expected). Blocks are `data: <single-line
 * JSON>\n\n`; the stream ends on a data payload starting with `[DONE]`.
 * Newlines inside chunk text are safe because JSON.stringify escapes them,
 * keeping each `data:` payload on one line. A chunk carrying an `error`
 * field makes the SDK throw mid-stream — the server's error kind uses a
 * non-2xx status instead, which both SDKs parse before streaming starts.
 */

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(model: string, content: string | undefined, finishReason: string | null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        delta: content === undefined ? {} : { content },
        finish_reason: finishReason,
      },
    ],
  };
}

export function openaiTextDelta(text: string, model: string): string {
  return dataLine(chunk(model, text, null));
}

/** Terminal finish chunk plus the `[DONE]` sentinel the SDK waits for. */
export function openaiStreamTail(model: string): string {
  return dataLine(chunk(model, undefined, "stop")) + "data: [DONE]\n\n";
}

/** The complete, well-formed stream for `kind: "stream"`. */
export function encodeOpenAIStream(chunks: string[], model: string): string {
  return chunks.map((text) => openaiTextDelta(text, model)).join("") + openaiStreamTail(model);
}
