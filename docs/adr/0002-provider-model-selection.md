# 2. Provider and model selection

## Status

Accepted.

## Context

For each of the three v1 providers, a specific model had to be chosen — and the app generates one short story paragraph per request, not long-form reasoning or code, so a provider's flagship/highest-reasoning model is not automatically the right fit. The PRD names cost control as an explicit v1 risk (no per-user accounts or rate limiting in v1 means no per-user cost caps), which makes the cost/quality tradeoff a real product decision, not just an implementation detail.

The third provider is an aggregator giving access to an open-weight model. Two real candidates exist: OpenRouter and Together. OpenRouter was chosen — it exposes an OpenAI-compatible chat completions API, which meant the adapter could reuse the same `openai` npm package already needed for the OpenAI provider (pointed at a different `baseURL`) instead of adding a fourth SDK dependency.

## Decision

| Provider | Model | Rationale |
|---|---|---|
| Anthropic | `claude-sonnet-5` | Balanced tier: appropriate quality at reasonable cost for single-paragraph generation. |
| OpenAI | `gpt-5-mini` | Balanced tier: appropriate quality at reasonable cost for single-paragraph generation. |
| OpenRouter (open-weight) | `meta-llama/llama-3.3-70b-instruct` | Good performance with 131K context window for creative writing tasks. |

Each model ID is a named constant at the top of its adapter file (`src/lib/providers/anthropic.ts`, `openai.ts`, `openrouter.ts`), not buried in a request body — changing a model later is a one-line diff.

The Anthropic adapter explicitly disables extended thinking (`thinking: { type: "disabled" }`). Claude Sonnet 5 has adaptive thinking on by default; when enabled, the `max_tokens` cap applies to *thinking and response text combined*, which risks a paragraph truncating mid-sentence because the token budget was spent on internal reasoning a short creative-writing paragraph doesn't need.

## Consequences

- Per-request cost is predictable across all three providers.
- Model choice is isolated to three constants; upgrading (e.g. to a future `claude-opus-6`) doesn't touch the interface, the registry, or calling code — only the constant.
- Pricing information should be verified against current provider documentation before making cost-sensitive decisions.
