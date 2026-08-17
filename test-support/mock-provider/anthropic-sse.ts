/**
 * SSE encoder for the Anthropic Messages wire format, as parsed by the
 * installed @anthropic-ai/sdk (see node_modules/@anthropic-ai/sdk/core/streaming.js
 * and lib/MessageStream.js — verified, not from memory).
 *
 * The SDK only yields events in its whitelist (message_start, content_block_*,
 * message_delta, message_stop, ping, error) and every block needs an
 * `event: <type>` line or it is silently dropped. Order is enforced: the
 * first event must be message_start, and finalMessage() — which our adapter
 * calls — throws "request ended without sending any chunks" unless the full
 * envelope through message_stop arrives. The message_start snapshot must
 * carry id/type/role/content/model/stop_reason/stop_sequence/usage.
 */

function sseBlock(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** message_start + content_block_start: the envelope opening. */
export function anthropicStreamHead(model: string): string {
  return (
    sseBlock("message_start", {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }) +
    sseBlock("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
  );
}

export function anthropicTextDelta(text: string): string {
  return sseBlock("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

/**
 * content_block_stop + message_delta (with stop_reason, or finalMessage()
 * leaves stop_reason null) + message_stop. Skip message_delta and the
 * adapter still works (it only special-cases "refusal") but the recording
 * would be unrealistic — always emit the full tail except for truncate.
 */
export function anthropicStreamTail(outputTokens: number): string {
  return (
    sseBlock("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseBlock("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: Math.max(1, outputTokens) },
    }) +
    sseBlock("message_stop", { type: "message_stop" })
  );
}

/** The complete, well-formed stream for `kind: "stream"`. */
export function encodeAnthropicStream(chunks: string[], model: string): string {
  const head = anthropicStreamHead(model);
  const deltas = chunks.map(anthropicTextDelta).join("");
  const tail = anthropicStreamTail(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  return head + deltas + tail;
}
