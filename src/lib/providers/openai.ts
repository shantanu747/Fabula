import OpenAI from "openai";
import { buildMessages, buildSystemPrompt, generateWithProvider } from "./prompt";
import type { GenerateParagraphInput, LLMProvider } from "./types";

// Balanced cost/quality pick, verified live against OpenAI's current pricing
// ($0.25 / $2.00 per MTok) — mirrors the Sonnet-5 choice for Anthropic. Cheaper:
// gpt-5-nano. Pricier: flagship gpt-5.
const OPENAI_MODEL = "gpt-5-mini";

// Constructed lazily, not at module scope — the SDK throws immediately if no API
// key is set, which would otherwise break `next build`/`next dev` startup before
// a developer has configured `.env.local`.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

async function* rawOpenAITextStream(input: GenerateParagraphInput): AsyncGenerator<string> {
  const stream = await getClient().chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: input.maxOutputTokens,
    stream: true,
    messages: [{ role: "system", content: buildSystemPrompt() }, ...buildMessages(input)],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export const openaiProvider: LLMProvider = {
  id: "openai",
  displayName: "GPT-5 mini (OpenAI)",
  generateParagraph(input) {
    return generateWithProvider(input, rawOpenAITextStream);
  },
};
