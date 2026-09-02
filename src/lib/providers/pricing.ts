import type { TokenUsage } from "./types";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Keyed by the concrete model id an adapter's ProviderTurnInfo reports, not by
 * provider id — the same provider can report a dated snapshot (OpenAI resolves
 * "gpt-5-mini" to "gpt-5-mini-2025-08-07") that wouldn't match a lookup keyed on
 * the adapter's own model constant. estimateCostUsd normalises for that.
 *
 * Every entry must be verified live and dated in a comment next to it — an
 * unknown model returns undefined from estimateCostUsd, never 0, which would
 * silently under-report cost instead of admitting the price isn't known.
 */
export const PRICING: Record<string, ModelPricing> = {
  // Standard pricing, verified 2026-09-01 against
  // platform.claude.com/docs/en/about-claude/pricing. The page's own note
  // confirms the previously scheduled Sept 1 2026 increase to $3/$15 did not
  // happen — $2/$10 is the standing price, not introductory.
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  // Verified live against OpenAI's pricing during eval-harness seeding
  // (2026-08-30) — see src/lib/providers/openai.ts's adapter comment.
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2.0 },
  // Verified live via openrouter.ai/docs — see
  // src/lib/providers/openrouter.ts's adapter comment.
  "meta-llama/llama-3.3-70b-instruct": { inputPerMTok: 0.1, outputPerMTok: 0.32 },
};

/**
 * Strips a trailing dated snapshot suffix (e.g. "gpt-5-mini-2025-08-07" ->
 * "gpt-5-mini") so a provider resolving an alias to a dated model doesn't miss
 * the table — the same normalisation evals/record.ts already applies when
 * comparing a live response's model against PROVIDER_MODELS.
 */
function normalizeModelId(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  const pricing = PRICING[model] ?? PRICING[normalizeModelId(model)];
  if (!pricing) return undefined;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}
