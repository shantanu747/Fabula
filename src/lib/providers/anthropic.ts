import Anthropic from "@anthropic-ai/sdk";
import { buildMessages, buildSystemPrompt, generateWithProvider, type ChatMessage } from "./prompt";
import type { GenerateParagraphInput, LLMProvider, ProviderTurnInfo } from "./types";

const EPHEMERAL_CACHE: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

/**
 * Marks the boundary between the stable, ever-growing story prefix and the
 * one message that's freshly built every turn (buildContinuationMessage,
 * whose length-steering text differs turn to turn — see prompt.ts). That
 * boundary is always the second-to-last message: buildMessages always shapes
 * its output as [...storySoFar mapped 1:1, continuationMessage].
 *
 * This index intentionally *advances* every turn rather than staying fixed —
 * that's the correct behavior for Anthropic's incremental cache matching, not
 * a bug: turn N's breakpoint caches "system + story through paragraph K", and
 * turn N+1 (which sends that identical prefix plus one more paragraph) gets a
 * cache read for it, then writes a new, one-paragraph-larger entry under its
 * own breakpoint. See docs/adr/0040.
 *
 * Only Anthropic needs this annotation (an explicit `cache_control` flag) —
 * OpenAI's caching is automatic once a prefix is stable, which is what
 * prompt.ts's chunked windowing (also docs/adr/0040) makes true for both.
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const breakpoint = messages.length - 2;
  return messages.map((m, i) =>
    i === breakpoint
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL_CACHE }] }
      : { role: m.role, content: m.content }
  );
}

// Balanced cost/quality pick for short-paragraph generation (not deep reasoning) —
// see the milestone plan for the Sonnet-vs-Opus-vs-Haiku tradeoff.
const ANTHROPIC_MODEL = "claude-sonnet-5";

// Constructed lazily, not at module scope — keeps this consistent with the other
// two adapters and avoids any build-time dependency on env vars being set.
//
// ANTHROPIC_BASE_URL exists so the eval harness (test-support/mock-provider) and
// the E2E harness can point the real adapter at a local scripted server instead of
// stubbing the adapter itself — stream parsing and metadata extraction stay in the
// tested path. It doubles as self-hosted-gateway support. The client is memoized,
// so the value is read once per process.
let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    });
  }
  return client;
}

async function* rawAnthropicTextStream(
  input: GenerateParagraphInput,
  trueCount: number
): AsyncGenerator<string, ProviderTurnInfo, unknown> {
  const stream = getClient().messages.stream(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: input.maxOutputTokens,
      // Adaptive thinking is on by default for this model; disabling it means
      // max_tokens caps prose only, avoiding a paragraph truncating mid-sentence
      // because the budget was spent on reasoning instead.
      thinking: { type: "disabled" },
      // Static across every request this app ever makes, so this cache entry
      // is shared across stories too, not just within one (docs/adr/0040).
      system: [{ type: "text", text: buildSystemPrompt(), cache_control: EPHEMERAL_CACHE }],
      messages: toAnthropicMessages(buildMessages(input, trueCount)),
    },
    { signal: input.signal }
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new Error("anthropic: generation refused by safety classifier");
  }

  return {
    model: final.model,
    usage: {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      // Always reported by the API (0 on a cache miss, never absent) — `?? undefined`
      // only guards the `number | null` type, it doesn't mean "maybe not reported".
      cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? undefined,
      cacheReadInputTokens: final.usage.cache_read_input_tokens ?? undefined,
    },
  };
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  displayName: "Claude (Anthropic)",
  generateParagraph(input) {
    return generateWithProvider(input, rawAnthropicTextStream);
  },
};
