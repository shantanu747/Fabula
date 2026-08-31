# 18. LLM evaluation harness

## Status

Accepted.

## Context

Fabula's only enforcement of its two most important behavioral promises — age-appropriate output (PRD §6, ADR 0006) and single-paragraph turn discipline (ADR 0004) — is wording inside `buildSystemPrompt()` and the message-building logic in `prompt.ts`. Nothing tested it. A wording change to the safety clause, the length-steering bands, the windowing note, or the zero-input metadata-header contract could degrade every generation the app makes while every existing test passed, because the existing tests assert mechanics (windowing counts, role alternation) rather than the contract the prompts are supposed to uphold.

We needed evals that gate PRs without spending tokens in CI, plus a way to notice when a provider silently changes a model behind a stable name — a failure mode pure replay cannot see.

## Decision

Three layers (spec: `docs/plans/v3/01-llm-eval-harness.md`):

**Layer 1 — prompt contract (per PR, free, deterministic).** `evals/eval.contract.test.ts` file-snapshots the exact `{ systemPrompt, messages }` the app builds for each of the 12 golden cases in `evals/cases.ts`, alongside assertions for the properties that must hold regardless of wording (safety clause present, length-band note per ratio band, windowing note exactly when paragraphs drop, header instruction only for the true zero-input kickoff, theme/characters reminder on later turns). Any prompt change shows up as a reviewable snapshot diff or a failed property.

**Layer 2 — output quality (per PR, free).** Recorded provider responses (`evals/fixtures/<provider>/<caseId>.json`) are replayed through the **real adapters** by pointing each SDK at a local mock provider server (`test-support/mock-provider/`) via the `*_BASE_URL` env seam. Adapter stream parsing, `extractInventedMetadata`, and windowing stay inside the exercised path rather than being stubbed out. Each replayed output gets deterministic structural checks (`evals/structural.ts`: one paragraph, 60–220 words, no author labels, headings, quote wrappers, or leaked `THEME:`/`---` scaffolding; plus parsed header metadata for the zero-input case) and a cached judge score from committed `evals/judgements/…` files keyed by `sha256(generatedText + caseId + rubricVersion)`.
**Staleness is a hard failure**: every fixture carries the `sha256` of the request payload it was recorded against, and if the payload the code builds today hashes differently the run fails with `fixture stale for <caseId>/<provider>: run npm run eval:record`. There is no warning tier; a prompt change cannot coast on old fixtures.

**Layer 3 — nightly live drift (`.github/workflows/eval-drift.yml`).** A scheduled job runs `npm run eval:live` = `tsx evals/run.ts --live --full`: live calls for the full matrix (39 generations + 39 judge calls), judged live, compared per-case against the committed `evals/baseline.json`. A dimension dropping more than `nightlyDriftTolerance` (0.5) below baseline, or a breached hard floor, fails the workflow and produces the Actions-tab failure mail. This layer costs money and never blocks a PR — by design.

**Thresholds** (`evals/thresholds.json`): `safety` is a per-case hard floor (4), never averaged — one unsafe generation out of twelve is a failure and a mean would hide it. `injection_resisted` must be true on every adversarial case. Structural must pass 100%. The other dimensions are pooled means over the executed matrix (`continuity` 4.0, `voice_match` 3.8, `single_turn` 4.5, `arc_steering` 3.8), because one mediocre continuation is noise, not a regression. "Pooled" is pinned: means are computed across every scored entry in the run's matrix, pooled across providers, not per-provider.

**Judge.** The judge is a pinned Anthropic model calling the SDK *directly*, deliberately bypassing `LLMProvider` — the interface exists for the app's model-agnosticism, while the judge must not be swappable or its scores stop being comparable across runs. It runs with thinking disabled, strict-JSON output, and `max_retries: 0` (a retried judge call makes scores silently non-comparable — and costs money — so a transient blip fails the job instead). `temperature: 0` was originally specified for determinism but the pinned judge (claude-opus-5) rejects it — the live API returns "`temperature` is deprecated for this model" (verified 2026-08-30 while seeding) — so it is omitted and the model runs at its own fixed default; that omission is load-bearing and must not be "fixed" back. The model was verified live before the first recording and pinned in `evals/rubric.ts` as `JUDGE_MODEL`. If that model is retired, replacing it is a **scoring change**: pin the new model, bump `RUBRIC_VERSION`, and re-record judgements + baseline in one commit.

**Fixtures at the HTTP layer, not the adapter layer.** Recording (`npm run eval:record` = `evals/record.ts`) injects a taping `fetch` into a real SDK client so the SDK's own request build (headers, JSON body, model params) produces the request while we persist only the raw SSE response body; request headers never leave the process, so no API key can land in a committed fixture. Replaying raw SSE through the mock + real SDK exercises the stream-decoder layer where our past stream bugs actually lived (ADR 0003, the sentinel property tests) — an adapter-boundary recording would skip exactly that code.

**On keeping the seam honest.** The only production change is the base-URL override in the three adapters. No stub provider in the registry, no `NODE_ENV === "test"` branches. The mock speaks vendor SSE on ephemeral ports with a pluggable script function supporting `stream` / `error` / `hang` / `truncate` kinds — Plans 2 (E2E) and 4 (timeouts) reuse it, so its wire shapes are pinned by `test-support/mock-provider/server.test.ts`, which streams through the real adapters end-to-end.

**Operational details.**
- `tsx` is declared as a devDependency pinned to the version already present in the tree (4.23.12) — it was previously available only transitively, which a dependency reshuffle could have silently removed from under `eval:record`/`eval:live`.
- The scripts use `node --env-file-if-exists=.env.local` so the identical command works locally (loads `.env.local`) and on the nightly runner (file absent, secrets injected as env).
- Adapter clients are memoized per process: the base-URL env var is read once, at first construction. The vitest eval suite and `run.ts` both set it before the first generation and never mix live and replay in one process; `pool: "forks"` gives each eval file its own process.
- The nightly workflow fails loudly (before spending anything) if any of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` is missing from repo secrets. A scheduled job that goes green because keys are absent is worse than a failure mail.
- `evals/report.json` is byte-deterministic across runs: sorted keys, rounded means, no wall-clock data (timestamps live only inside fixture/judgement files). `report.json`/`report.md` are gitignored artifacts; `baseline.json`, thresholds, fixtures, judgements, and prompt snapshots are committed.

## Consequences

Every prompt change now surfaces as a reviewable Layer-1 snapshot diff, and any change that alters the request payload forces a deliberate `npm run eval:record` — a local, money-spending act — before the PR gate goes green. Prompt regressions are caught where they're made; model regressions surface the next morning via the nightly.

What the PR gate does **not** prove: fixtures are a snapshot of model behavior at record time. Green Layer-2 means "the prompt didn't regress against recorded behavior"; only the nightly covers "the model still behaves." That asymmetry is intentional — the PR gate stays free and deterministic, and drift is a triage signal, not a blocker.

Maintenance rules that follow from the design: bumping the judge or rubric text is a scoring change requiring re-record + baseline refresh in one commit; model bumps in an adapter must be mirrored in `evals/cases.ts`'s `PROVIDER_MODELS` or recording fails loudly.

## Rejected

- **LLM-as-judge on every PR** — cost and, worse, non-determinism: the same fixture could flip a gate run to run.
- **Pure assertion-based checks with no judge** — can't score continuity or voice match, which are exactly the dimensions a rewritten system prompt degrades.
- **Recording at the adapter boundary** (capturing parsed text instead of raw SSE) — wouldn't exercise the SDK stream decoders, which is where our real bugs historically lived.
