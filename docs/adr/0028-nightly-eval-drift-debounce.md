# 28. Nightly eval-drift debounce and wider tolerance

## Status

Accepted. Amends ADR 0018's Layer 3.

## Context

`eval-drift.yml` (ADR 0018 Layer 3) had failed every single scheduled run since it was introduced — 10 for 10 over the runs since it started, spending real provider tokens each night with no useful signal.

Investigating the actual failure logs (`gh run view <id> --log-failed` across all 10 runs) ruled out configuration: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` were present as repo secrets, the job genuinely called all three providers and the judge, and it produced real scores. The failures were legitimate output of `evaluateDrift`/`evaluateEntries` — but the pattern across nights was the tell:

- Every failing dimension was the live score exactly **one point below baseline**, never two or more, and never the reverse (baseline never showed live scoring higher, though nothing about the comparison only permits that direction — it's just what one-point noise centered near a threshold looks like when only the downward crossings are checked).
- Failures clustered on the same handful of long-form/subjective cases each night (`arc-climax`, `arc-resolution`, `arc-rising`, `windowed-long-story`, `safety-dark-turn`) and dimensions (`continuity`, `arc_steering`, `voice_match`, `single_turn`) — the cases requiring the most judgment call from the LLM judge, not the mechanical ones.
- Failures hit **Anthropic, OpenAI, and OpenRouter simultaneously on the same nights**. Three unrelated vendors do not silently regress behind stable model names in lockstep on the same random nights, repeatedly, for ten days straight.

That combination means the signal is dominated by measurement noise, not by three vendors drifting in sync. Two compounding causes:

1. **Two independent, uncontrolled sampling sources.** Neither story generation (no provider adapter sets `temperature`) nor the judge (`temperature` is explicitly omitted — the pinned `claude-opus-5` judge rejects `temperature: 0`, per ADR 0018) is deterministic. Every night is one fresh, unrepeated sample of both.
2. **The comparison had zero slack for that noise.** `nightlyDriftTolerance` was `0.5` against integer 1–5 judge scores, which mathematically requires live to equal-or-beat baseline exactly — any single-point dip trips it. `evals/baseline.json` itself is one frozen sample from one `--write-baseline` run, not a stable statistical anchor. The pooled `means` thresholds (`evals/thresholds.json`) have the same problem: they're computed from one night's single-sample scores and sit close enough to the natural mean (e.g. `arc_steering: 3.8`) that ordinary sampling variance crosses them.

ADR 0018 already reasoned about exactly this failure mode — it rejected LLM-as-judge on every PR specifically because "the same fixture could flip a gate run to run" (single-sample non-determinism). Layer 3 reintroduced that identical non-determinism against a fixed baseline with an even tighter tolerance, with no PR author in the loop to notice a spurious flip — just a failure mail, every night, indefinitely.

## Decision

Two changes, both scoped to the **score-based** checks only (pooled `means` thresholds and baseline `drift` comparisons). Structural checks, the `safety` hard floor, and `injection_resisted` remain zero-tolerance and immediate, exactly as ADR 0018 pinned them — those are deliberate strict gates, not something this investigation found to be noisy in the same way, and softening a content-safety gate wasn't asked for.

1. **Widen `nightlyDriftTolerance` from `0.5` to `1.5`** (`evals/thresholds.json`) — absorbs a single-point judge/generation blip while still catching a real ≥2-point collapse same-night.
2. **Require the same failure to occur on two consecutive nightly runs before it fails the job.** `evals/report.ts` now emits structured `Failure` objects (`{ key, message, debounceEligible, status }`) instead of plain strings. `key` identifies the check (provider/case/dimension) without embedding the actual scores, so the same underlying check can be recognized night over night. `debounceEligible` is `true` only for `mean:*` and `drift:*` failures.

   The workflow (`eval-drift.yml`) fetches the most recent previous `eval-report` artifact via `gh api .../actions/artifacts?name=eval-report` + `gh run download`, before spending any tokens, and points `EVAL_PREVIOUS_REPORT` at its `report.json`. `evals/run.ts` loads that file's failure `key`s and downgrades any debounce-eligible failure not present in that set to `status: "pending"` — logged and included in `report.json`/`report.md` for visibility, but it does not fail the job. Only `status: "confirmed"` failures (debounce-ineligible checks, or debounce-eligible checks that also failed last night) set the exit code and the failure-mail subject line.

   `report.json`'s `failures` array always carries every raw failure key from that run — pending or confirmed — because that file is exactly what next night's job reads back to decide what's now confirmed.

Fetching the artifact is best-effort: no previous artifact (first run after this change, an expired one past the 90-day retention, or a `report.json` in the old plain-string format) just means every debounce-eligible failure tonight starts as `pending`, which is the same as saying "we have no history yet" — it does not throw or silently skip the checks themselves.

## Consequences

- A genuine, persistent model regression is now caught within two nights instead of one. That's an acceptable trade for a layer that ADR 0018 already designed to "never block a PR" and to be "a triage signal, not a blocker" — the cost of a 24h detection delay is far lower than the cost of a monitor that has never once told anyone anything real.
- The night this ships (and any night after a judge/rubric/model bump forces a baseline or judgement re-record), the job starts from an empty previous-failure set, so nothing fails immediately even if real drift happens to be present that night — it would need to repeat the following night to confirm. This is a known blind spot inherent to debouncing and is judged acceptable for a non-blocking nightly tripwire.
- `evals/report.ts`'s public functions (`evaluateEntries`, `evaluateDrift`, `writeReports`) now operate on `Failure[]` instead of `string[]`; `report.json`'s `failures` field changed shape from `string[]` to `Array<{ key, message, status }>`. Any external consumer of the old `report.json` shape (there were none in-repo besides `evals/eval.quality.test.ts`, updated alongside this) would need updating.
- This does not touch how `npm run eval` (Layer 1/2, the free PR-gate replay path) behaves: it has no baseline/drift concept and no previous-run history to debounce against, so every failure there is `status: "confirmed"` immediately, same as before.

## Rejected

- **Multi-sample averaging** (run each case N times per night, rebuild `baseline.json` the same way, compare pooled means) — catches real drift the same night instead of after a repeat, but roughly triples Layer 3's per-night token spend and runtime for a layer whose own ADR already accepts a day's detection latency in exchange for staying off the PR path.
- **Widening tolerance alone, with no debounce** — a one-line change, but doesn't address the `mean` threshold false positives (e.g. `mean arc_steering: 3.7778 < 3.8`), which aren't gated by `nightlyDriftTolerance` at all, and picks a single magic number to paper over noise whose magnitude isn't actually known to stay under any fixed bound forever.
