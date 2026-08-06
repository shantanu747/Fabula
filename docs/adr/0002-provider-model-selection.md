# 2. Provider and model selection

## Status

Accepted.

## Context

For each of the three v1 providers, a specific model had to be chosen — and the app generates one short story paragraph per request, not long-form reasoning or code, so a provider's flagship/highest-reasoning model is not automatically the right fit. The PRD names cost control as an explicit v1 risk (no per-user accounts or rate limiting in v1 means no per-user cost caps), which makes the cost/quality tradeoff a real product decision, not just an implementation detail. Model IDs and pricing were verified against each provider's current documentation at decision time rather than assumed from training data, since model lineups change frequently.

The third provider is an aggregator giving access to an open-weight model. Two real candidates exist: OpenRouter and Together. OpenRouter was chosen — it exposes an OpenAI-compatible chat completions API, which meant the adapter could reuse the same `openai` npm package already needed for the OpenAI provider (pointed at a different `baseURL`) instead of adding a fourth SDK dependency.

## Decision

| Provider | Model | Rationale |
|---|---|---|
| Anthropic | `claude-sonnet-5` | Balanced tier: "near-Opus quality" at roughly 60% of Opus 5's per-token cost. Opus 5 was rejected as over-provisioned for single-paragraph generation; Haiku 4.5 was available as a cheaper option but Sonnet was judged the better quality/cost balance for user-facing creative prose. |
| OpenAI | `gpt-5-mini` | Verified live against OpenAI's pricing page: $0.25/$2.00 per million tokens, the direct mid-tier analog to the Sonnet-5 choice above (cheaper: `gpt-5-nano` at $0.05/$0.40; pricier: flagship `gpt-5` at $1.25/$10.00; `gpt-4o`/`gpt-4o-mini` remain available but are an older model generation). |
| OpenRouter (open-weight) | `meta-llama/llama-3.3-70b-instruct` | Verified live against OpenRouter's model listing: 131K context window, $0.10/$0.32 per million tokens. |

Each model ID is a named constant at the top of its adapter file (`src/lib/providers/anthropic.ts`, `openai.ts`, `openrouter.ts`), not buried in a request body — changing a model later is a one-line diff.

The Anthropic adapter explicitly disables extended thinking (`thinking: { type: "disabled" }`). Claude Sonnet 5 has adaptive thinking on by default; when enabled, the `max_tokens` cap applies to *thinking and response text combined*, which risks a paragraph truncating mid-sentence because the token budget was spent on internal reasoning a short creative-writing paragraph doesn't need.

## Consequences

- Per-request cost is bounded and predictable across all three providers at a comparable tier, rather than accidentally comparing a cheap tier on one provider against a flagship tier on another.
- Model choice is isolated to three constants; upgrading (e.g. to a future `claude-opus-6`) doesn't touch the interface, the registry, or calling code — only the constant.
- Pricing shifts over time. These figures were accurate when verified during this decision and should be re-checked before assuming they still hold in a cost-sensitive future change.
