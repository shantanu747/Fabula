import OpenAI from "openai";
import { buildMessages, buildSystemPrompt, generateWithProvider } from "./prompt";
import type { GenerateParagraphInput, LLMProvider, ProviderTurnInfo } from "./types";

// Balanced cost/quality pick, verified live against OpenAI's current pricing
// ($0.25 / $2.00 per MTok) — mirrors the Sonnet-5 choice for Anthropic. Cheaper:
// gpt-5-nano. Pricier: flagship gpt-5.
const OPENAI_MODEL = "gpt-5-mini";

// Constructed lazily, not at module scope — the SDK throws immediately if no API
// key is set, which would otherwise break `next build`/`next dev` startup before
// a developer has configured `.env.local`.
// OPENAI_BASE_URL exists so the eval harness (test-support/mock-provider) and the
// E2E harness can point the real adapter at a local scripted server instead of
// stubbing the adapter itself — stream parsing and metadata extraction stay in the
// tested path. It doubles as self-hosted-gateway support. The client is memoized,
// so the value is read once per process.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });
  }
  return client;
}

async function* rawOpenAITextStream(
  input: GenerateParagraphInput,
  trueCount: number
): AsyncGenerator<string, ProviderTurnInfo, unknown> {
  const stream = await getClient().chat.completions.create(
    {
      model: OPENAI_MODEL,
      max_completion_tokens: input.maxOutputTokens,
      // Reasoning tokens count against max_completion_tokens. Without this,
      // gpt-5-mini's default reasoning can exhaust the whole 600-token budget
      // and return an empty completion (finish_reason "length") — verified live
      // during eval seeding (2026-08-30). "low" keeps prose within the cap.
      reasoning_effort: "low",
      stream: true,
      // The usage-bearing chunk arrives last, with an empty `choices` array — the
      // loop below already skips it safely (no delta to yield), so this is a pure
      // addition that costs nothing on the happy path.
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...buildMessages(input, trueCount),
      ],
    },
    { signal: input.signal }
  );

  let model = OPENAI_MODEL;
  let usage: ProviderTurnInfo["usage"];
  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
    if (chunk.usage) {
      // Caching here is automatic (no request-side flag) once the stable-prefix
      // windowing in prompt.ts makes a turn's messages a pure append of the
      // previous turn's (docs/adr/0040) — this just reads the result back.
      // OpenAI's `cached_tokens` is a SUBSET of `prompt_tokens`, unlike
      // Anthropic's cache fields which are additive alongside input_tokens
      // (see TokenUsage's doc comment) — subtract it out here so inputTokens
      // means the same "fresh, uncached" thing for every provider. Left as
      // `undefined` (not 0) whenever the API omits the details object
      // entirely — a real reported 0 (cache supported, just no hit this turn)
      // stays 0, distinct from "not reported at all" (docs/adr/0022).
      const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        inputTokens: chunk.usage.prompt_tokens - (cachedTokens ?? 0),
        outputTokens: chunk.usage.completion_tokens,
        cacheReadInputTokens: cachedTokens,
      };
    }
  }

  return { model, usage };
}

export const openaiProvider: LLMProvider = {
  id: "openai",
  displayName: "GPT-5 mini (OpenAI)",
  generateParagraph(input) {
    return generateWithProvider(input, rawOpenAITextStream);
  },
};
