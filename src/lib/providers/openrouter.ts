import OpenAI from "openai";
import { buildMessages, buildSystemPrompt, generateWithProvider } from "./prompt";
import type { GenerateParagraphInput, LLMProvider } from "./types";

// Verified live via openrouter.ai/docs — 131K context, $0.10/$0.32 per MTok.
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct";

// Constructed lazily, not at module scope — the SDK throws immediately if no API
// key is set, which would otherwise break `next build`/`next dev` startup before
// a developer has configured `.env.local`.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
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

async function* rawOpenRouterTextStream(input: GenerateParagraphInput): AsyncGenerator<string> {
  const stream = await getClient().chat.completions.create({
    model: OPENROUTER_MODEL,
    max_tokens: input.maxOutputTokens,
    stream: true,
    messages: [{ role: "system", content: buildSystemPrompt() }, ...buildMessages(input)],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export const openrouterProvider: LLMProvider = {
  id: "openrouter",
  displayName: "Llama 3.3 (OpenRouter)",
  generateParagraph(input) {
    return generateWithProvider(input, rawOpenRouterTextStream);
  },
};
