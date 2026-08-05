import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { openrouterProvider } from "./openrouter";
import type { LLMProvider } from "./types";

export const PROVIDERS: Record<string, LLMProvider> = {
  [anthropicProvider.id]: anthropicProvider,
  [openaiProvider.id]: openaiProvider,
  [openrouterProvider.id]: openrouterProvider,
};

export function getProvider(id: string): LLMProvider | undefined {
  return PROVIDERS[id];
}
