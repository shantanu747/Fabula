import Anthropic from "@anthropic-ai/sdk";
import { buildMessages, buildSystemPrompt, generateWithProvider } from "./prompt";
import type { GenerateParagraphInput, LLMProvider } from "./types";

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
): AsyncGenerator<string> {
  const stream = getClient().messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: input.maxOutputTokens,
    // Adaptive thinking is on by default for this model; disabling it means
    // max_tokens caps prose only, avoiding a paragraph truncating mid-sentence
    // because the budget was spent on reasoning instead.
    thinking: { type: "disabled" },
    system: buildSystemPrompt(),
    messages: buildMessages(input, trueCount),
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new Error("anthropic: generation refused by safety classifier");
  }
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  displayName: "Claude (Anthropic)",
  generateParagraph(input) {
    return generateWithProvider(input, rawAnthropicTextStream);
  },
};
