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

/** Which env var each adapter reads its API key from (see anthropic.ts,
 *  openai.ts, openrouter.ts's own getClient()). Kept here, next to the
 *  registry, rather than scattering process.env checks elsewhere. */
const API_KEY_ENV_VAR: Record<string, string> = {
  [anthropicProvider.id]: "ANTHROPIC_API_KEY",
  [openaiProvider.id]: "OPENAI_API_KEY",
  [openrouterProvider.id]: "OPENROUTER_API_KEY",
};

/** Whether a provider can actually be called — its key is configured. Returns a
 *  boolean only; never expose which env vars are set, or their values. */
export function isConfigured(id: string): boolean {
  const envVar = API_KEY_ENV_VAR[id];
  return envVar !== undefined && Boolean(process.env[envVar]);
}

/** The first configured provider other than `excludeId`, in registry order.
 *  Undefined when nothing else is available. */
export function suggestAlternative(excludeId: string): string | undefined {
  return Object.keys(PROVIDERS).find((id) => id !== excludeId && isConfigured(id));
}
