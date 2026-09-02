import OpenAI from "openai";
import { buildMessages, buildSystemPrompt, generateWithProvider } from "./prompt";
import type { GenerateParagraphInput, LLMProvider, ProviderTurnInfo } from "./types";

// Verified live via openrouter.ai/docs — 131K context, $0.10/$0.32 per MTok.
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct";

// Constructed lazily, not at module scope — the SDK throws immediately if no API
// key is set, which would otherwise break `next build`/`next dev` startup before
// a developer has configured `.env.local`.
// OPENROUTER_BASE_URL exists so the eval harness (test-support/mock-provider) and
// the E2E harness can point the real adapter at a local scripted server instead of
// stubbing the adapter itself — stream parsing and metadata extraction stay in the
// tested path. It doubles as self-hosted-gateway support. The client is memoized,
// so the value is read once per process.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      defaultHeaders: {
        ...(process.env.OPENROUTER_SITE_URL
          ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
          : {}),
        ...(process.env.OPENROUTER_SITE_NAME
          ? { "X-OpenRouter-Title": process.env.OPENROUTER_SITE_NAME }
          : {}),
      },
    });
  }
  return client;
}

// Set once a response has completed with no usage chunk, so the console gets one
// diagnostic instead of one per request — see the `usage: undefined` fallback below.
let warnedMissingUsage = false;

async function* rawOpenRouterTextStream(
  input: GenerateParagraphInput,
  trueCount: number
): AsyncGenerator<string, ProviderTurnInfo, unknown> {
  const stream = await getClient().chat.completions.create({
    model: OPENROUTER_MODEL,
    max_tokens: input.maxOutputTokens,
    stream: true,
    // Not every OpenRouter upstream honours this — see the fallback below, which
    // never fabricates a usage number if the provider doesn't return one.
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: buildSystemPrompt() },
      ...buildMessages(input, trueCount),
    ],
  });

  let model = OPENROUTER_MODEL;
  let usage: ProviderTurnInfo["usage"];
  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
    }
  }

  if (usage === undefined && !warnedMissingUsage) {
    warnedMissingUsage = true;
    console.warn(
      "[openrouter] no token usage in the stream despite stream_options.include_usage — " +
        "cost/usage attributes will be omitted for this provider until it's supported upstream."
    );
  }

  return { model, usage };
}

export const openrouterProvider: LLMProvider = {
  id: "openrouter",
  displayName: "Llama 3.3 (OpenRouter)",
  generateParagraph(input) {
    return generateWithProvider(input, rawOpenRouterTextStream);
  },
};
