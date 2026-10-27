# Model refresh (2026-10): Sonnet 5.5, GPT-6 Luna, Opus 5.5 judge

This plan is written to be executed by an agent with **no prior context** on the conversation
that produced it. Follow it in order. Where it says **STOP**, stop and report to the user instead
of improvising — see "Stop conditions" at the end.

Read `AGENTS.md` first (it governs everything below), then this file end to end before touching
code. Use the graphify-first rule from `AGENTS.md` for any codebase question this plan doesn't
already answer.

---

## 0. Decisions already made (do not re-litigate)

The repo owner approved these explicitly:

| Surface | Today | Target | Why |
|---|---|---|---|
| Anthropic generation (`src/lib/providers/anthropic.ts`) | `claude-sonnet-5` | `claude-sonnet-5-5` | Same $2 / $10 per MTok; cache reads halve ($0.20 → $0.10). Newer model, same cost. |
| OpenAI generation (`src/lib/providers/openai.ts`) | `gpt-5-mini` | `gpt-6-luna` | $0.25 / $2.00 → $0.10 / $0.50 per MTok (reported; verify in Gate 0). |
| Eval judge (`evals/rubric.ts` `JUDGE_MODEL`) | `claude-opus-5` | `claude-opus-5-5` | $5 / $25 → $4 / $20. Owner accepts re-recording all evals. |
| OpenRouter (`src/lib/providers/openrouter.ts`) | `meta-llama/llama-3.3-70b-instruct` | **unchanged** | Out of scope for this pass. |

Decisions this plan makes for you (the reasoning is in the ADR you will write in Step 7):

1. **Sonnet 5.5 runs with `thinking: { type: "between_tools" }` and `output_config: { effort: "low" }`.**
   Sonnet 5.5 rejects `thinking: { type: "disabled" }` with a 400. `between_tools` is its lowest
   thinking setting: with no tools in the request, the model does no extended thinking. That keeps
   ADR 0002's contract that `max_tokens` caps prose only. `low` is Anthropic's recommended starting
   effort for content generation. `between_tools` only works at effort `high` or below, takes **no
   other field** inside `thinking`, and only Sonnet 5.5 accepts it.
2. **GPT-6 Luna runs with `reasoning_effort: "none"`.** The model reportedly defaults to `medium`
   reasoning. Reasoning tokens count against `max_completion_tokens`, which is exactly the
   empty-paragraph bug `constants.ts` documents for `gpt-5-mini`. `none` removes that failure mode.
   If `none` is rejected or quality fails, fall back once to `"low"` (Step 6).
3. **The judge runs on Opus 5.5 with adaptive thinking (omit the `thinking` field) at
   `output_config: { effort: "medium" }`, with `max_tokens: 16000`.** Opus 5.5 rejects
   `thinking: { type: "disabled" }` at **every** effort level. Thinking counts toward `max_tokens`,
   so today's 1024 would truncate the JSON verdict. `medium` is the API default on Opus 5.5; set it
   explicitly anyway so the pinned judge doesn't move if the default changes.
4. **No server-side refusal fallbacks**, neither on generation nor on the judge.
   - **Judge:** a fallback silently swaps the scoring model. That breaks ADR 0018's pinned-judge
     guarantee.
   - **Generation:** Sonnet 5.5's `fallbacks: "default"` only retries `cyber` and `frontier_llm`
     refusals, neither of which story prose hits. It would also report a different `model`, which
     breaks `evals/record.ts`'s model assertion and cost accounting. A refusal stays a thrown error,
     and the app's existing provider-failover prompt (docs/plans/v3/04) handles it, as today.
5. **Old `PRICING` entries stay.** Historical `generation_event` rows and existing tests reference
   `claude-sonnet-5` and `gpt-5-mini`. Add new entries; don't delete old ones.
6. **Don't churn unrelated test fixtures.** Tests that use `"claude-sonnet-5"` / `"gpt-5-mini"` as
   arbitrary fake data (`metrics.test.ts`, `protocol.test.ts`, `generationEvents.db.test.ts`,
   `mock-provider/server.test.ts`, etc.) keep working because the old pricing entries stay. Only
   change a test string when a test fails or asserts on the adapter's real constant or display name.

### What is verified vs. not (confidence)

- **[Certain] Anthropic prices and API behavior.** Verified live 2026-10-27 at
  platform.claude.com/docs/en/about-claude/pricing, plus Anthropic's model-migration guide.
  - Sonnet 5.5: $2 in, $10 out, $2.50 5-minute cache write, $0.10 cache read.
  - Opus 5.5: $4 in, $20 out, $5 cache write, $0.20 cache read.
  - Sonnet 5.5's minimum cacheable prompt is 512 tokens, down from 1024 on Sonnet 5.
- **[Likely] GPT-6 Luna facts, unconfirmed against OpenAI's own pages.** The planning session's
  sandbox could not reach `developers.openai.com` (DNS blocked), so these come from search snippets
  of OpenAI's model page and from third-party aggregators:
  - Model ID is `gpt-6-luna`, and `/v1/chat/completions` is supported.
  - `reasoning.effort` accepts `none`, `low`, `medium` (default), `high`, `xhigh` and `max`.
  - 1.05M context window and 128K max output.
  - Released about 2026-09-22.
  - Priced at $0.10 in, $0.01 cached in, $0.50 out per MTok.
- **[Guessing, must resolve in Gate 0]** One third-party parameter site marks `gpt-6-luna`
  "deprecated, shutdown 2026-10-23, replacement gpt-5.6-sol". Several other sources name
  `gpt-6-luna` as OpenAI's *replacement* for models retiring in 2027. That claim is probably wrong,
  but it must be checked before writing code.
- **[Unknown]** Whether `gpt-6-luna` responses carry a dated snapshot suffix in `chunk.model`.
  `pricing.ts` and `record.ts` already strip `-YYYY-MM-DD`; Gate 0 confirms the actual shape.

---

## Gate 0 — preflight (no code changes yet)

Do every item. Any failure is a **STOP**.

1. **Keys.** `.env.local` must contain real `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
   `OPENROUTER_API_KEY`: `evals/record.ts` refuses to run without all three. If any is missing,
   **STOP** and ask the user to add it.
2. **Verify `gpt-6-luna` is live and not deprecated:**
   ```bash
   set -a; . ./.env.local; set +a
   curl -sS https://api.openai.com/v1/models/gpt-6-luna -H "Authorization: Bearer $OPENAI_API_KEY"
   ```
   Expect a model object with `"id": "gpt-6-luna"`. A 404 → **STOP**.
   Then make one tiny streaming call and record what comes back:
   ```bash
   curl -sS https://api.openai.com/v1/chat/completions \
     -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
     -d '{"model":"gpt-6-luna","stream":true,"stream_options":{"include_usage":true},
          "reasoning_effort":"none","max_completion_tokens":200,
          "messages":[{"role":"user","content":"Write one sentence about a lighthouse."}]}'
   ```
   Note three things:
   - **(a)** The `model` string in the chunks (bare or dated?).
   - **(b)** That `reasoning_effort: "none"` is accepted. If it's rejected, repeat with `"low"` and
     use `"low"` everywhere below.
   - **(c)** That the final chunk carries `usage.prompt_tokens_details.cached_tokens`.
3. **Verify GPT-6 Luna pricing** on OpenAI's pricing page (input, cached input, output; and whether
   cache writes are billed). If the numbers differ from $0.10 / $0.01 / $0.50, use the verified
   numbers in Step 1 and say so in the PR. If you can't reach the page, **STOP**: `pricing.ts`'s own
   rule is that every entry is verified live and dated.
4. **Verify the Anthropic model IDs respond.** One `messages.create` each against
   `claude-sonnet-5-5` with `thinking: {type: "between_tools"}` and `output_config: {effort: "low"}`,
   and against `claude-opus-5-5` with `output_config: {effort: "medium"}` and no `thinking` field.
   Both must return 200.
5. **SDK types.** Run `npm ci`, then check whether the installed SDKs type the new parameters:
   ```bash
   grep -rn "between_tools" node_modules/@anthropic-ai/sdk/resources/messages/*.d.ts | head -3
   grep -rn "effort" node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts | head -3
   grep -rn "'none'" node_modules/openai/resources/shared.d.ts | head -3
   ```
   - If `between_tools` or `output_config.effort` is not typed, upgrade within the current major:
     `npm install @anthropic-ai/sdk@^0` (stay on 0.x). Then re-run `npm run typecheck` and
     `npm test` before going further.
   - If only a new **major** version has the types, **STOP** and ask. A major SDK upgrade is its
     own change.
   - Same rule for `openai` and `reasoning_effort: "none"`.
   - Never paper over a missing type with `as any`. A narrowly-scoped, commented cast on the
     `thinking` object is acceptable **only** if the user approves it after you STOP.

---

## Branch

```bash
git fetch origin main
git checkout -B chore/model-refresh-2026-10 origin/main
```

One branch, one PR. Commits are ordered so each eval recording measures one change at a time:
**the judge swap is recorded against the old generators first**. That way the comparison of new
generators against the new judge is not confounded by the judge changing at the same time.

---

## Step 1 — Pricing (commit A: "feat(pricing): per-model cache rates; add claude-sonnet-5-5 and gpt-6-luna")

File: `src/lib/providers/pricing.ts`

1. Extend `ModelPricing` with optional per-model cache rates that override the global multipliers:
   ```ts
   export interface ModelPricing {
     inputPerMTok: number;
     outputPerMTok: number;
     /** Overrides CACHE_READ_MULTIPLIER × input when the vendor's cache-read rate isn't 0.1×. */
     cacheReadPerMTok?: number;
     /** Overrides CACHE_WRITE_MULTIPLIER × input when the vendor's cache-write rate isn't 1.25×. */
     cacheWritePerMTok?: number;
   }
   ```
   In `estimateCostUsd`, use `pricing.cacheReadPerMTok ?? pricing.inputPerMTok * CACHE_READ_MULTIPLIER`
   and the same pattern for writes. Update the multiplier doc comment: the 0.1× / 1.25× values are
   now *defaults*, and Sonnet 5.5's cache read is 0.05× its input price, which is why the override
   exists.
2. Add entries, each with a dated "verified" comment in the file's existing style:
   ```ts
   "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 }, // write $2.50 = default 1.25×
   "gpt-6-luna": { inputPerMTok: 0.1, outputPerMTok: 0.5 }, // cached $0.01 = default 0.1× — use Gate 0's verified numbers
   ```
   Leave the `claude-sonnet-5`, `gpt-5-mini` and Llama entries untouched, and add a one-line
   comment that the old two are retained for historical `generation_event` rows.
3. Tests in `src/lib/providers/pricing.test.ts`:
   - `claude-sonnet-5-5` cache reads cost $0.10 per MTok, not $0.20.
   - `claude-sonnet-5-5` cache writes still cost $2.50 per MTok.
   - `gpt-6-luna` base input and output rates.
   - Existing `claude-sonnet-5` expectations still pass unchanged (proves the default path).
4. Run `npm run lint && npm run typecheck && npm test`, then commit.

No behavior change ships in this commit: no adapter reports the new IDs yet.

---

## Step 2 — Fingerprint the request parameters too (part of commit B)

**Problem:** `EvalRequestPayload` (`evals/fingerprint.ts`) hashes only `model`, `maxTokens`,
`systemPrompt` and `messages`. A change to `thinking`, `effort` or `reasoning_effort`, which is
exactly what this migration changes, would therefore coast on stale fixtures. This migration
re-records everything anyway, so close the gap now.

1. In `evals/fingerprint.ts`, add `requestParams: Record<string, unknown>` to `EvalRequestPayload`.
2. In `evals/cases.ts`, next to `PROVIDER_MODELS`, add `PROVIDER_REQUEST_PARAMS`. It mirrors each
   adapter's non-message parameters, with the same doc-comment rationale as `PROVIDER_MODELS`.
   Commit B holds the **current** generator values:
   ```ts
   export const PROVIDER_REQUEST_PARAMS: Record<ProviderId, Record<string, unknown>> = {
     anthropic: { thinking: { type: "disabled" } },
     openai: { reasoning_effort: "low" },
     openrouter: {},
   };
   ```
   `buildEvalPayload` sets `requestParams: PROVIDER_REQUEST_PARAMS[providerId]`.
3. In `evals/record.ts` `captureLiveGeneration`, spread `payload.requestParams` into each vendor's
   request in place of the hard-coded `thinking` / `reasoning_effort` literals. That way the
   recorded request and the fingerprint come from one table and can't drift from each other. Keep
   the existing comments explaining *why* each parameter exists; move them to the table.
4. Update `evals/fingerprint.test.ts`: changing `requestParams` must change the fingerprint.

---

## Step 3 — Judge swap, recorded against the OLD generators (commit B: "feat(evals): pin judge to claude-opus-5-5, fingerprint request params")

Files: `evals/rubric.ts`, `evals/judge.ts`

1. `evals/rubric.ts`:
   - `JUDGE_MODEL = "claude-opus-5-5"`.
   - `RUBRIC_VERSION = "2"`. The judgement cache key is `sha256(text + caseId + rubricVersion)`
     and does **not** include the judge model, so the bump is what invalidates every v1 judgement
     by construction, as ADR 0018 requires for a judge change.
   - Update the doc comment.
2. `evals/judge.ts` `judgeParagraph`:
   - Remove `thinking: { type: "disabled" }`. Opus 5.5 returns a 400 for it.
   - Add `output_config: { effort: "medium" }`.
   - `max_tokens: 1024` → `16000`. Thinking counts toward it; 16000 is the non-streaming default
     that stays under SDK HTTP timeouts.
   - Keep `maxRetries: 0`, keep no `temperature`, and do **not** add `fallbacks`.
   - Before reading content, add explicit stop-reason guards so a failed judge call is legible:
     ```ts
     if (response.stop_reason === "refusal") throw new Error(`judge refused (${response.stop_details?.category ?? "unknown"})`);
     if (response.stop_reason === "max_tokens") throw new Error("judge hit max_tokens before finishing its verdict");
     ```
   - The existing `content.find((b) => b.type === "text")` already copes with a leading `thinking`
     block. Keep it.
   - Rewrite the header comment: "thinking disabled" no longer holds. Explain that Opus 5.5 can't
     disable thinking, so the pinned judge runs adaptive thinking at an explicit `medium` effort.
     Keep the `temperature` note, updated to name `claude-opus-5-5`.
3. Re-record with the **old** generators still in place:
   ```bash
   npm run eval:record
   npm run eval:live -- --write-baseline
   npm run eval            # replay must pass
   ```
   - Read the `eval:live` report. Under a new judge, small score shifts are expected.
   - Any **safety** score below 5, or any adversarial case with `injection_resisted: false`, that
     wasn't there under the old judge → **STOP** and report. The judge change would be moving the
     hard floor.
4. Run the fast checks (`npm run lint`, `npm run typecheck`, `npm test`), then commit. The commit
   includes Steps 2–3 code, `evals/fixtures/**`, `evals/judgements/**` and `evals/baseline.json`.
   This baseline is the **reference** for Step 6.

---

## Step 4 — Anthropic adapter → Sonnet 5.5 (part of commit C)

File: `src/lib/providers/anthropic.ts`

1. `const ANTHROPIC_MODEL = "claude-sonnet-5-5";`. Update the comment above it to point at the new
   ADR instead of "the milestone plan".
2. In the `messages.stream` request, replace `thinking: { type: "disabled" }` with:
   ```ts
   // Sonnet 5.5 rejects { type: "disabled" } (400). between_tools is its lowest thinking
   // setting — with no tools in the request the model does no extended thinking, so
   // max_tokens still caps prose only (ADR 0002's original reason). It accepts no other
   // field inside `thinking`, only effort `high` or below, and only on Sonnet 5.5 —
   // any code that re-sends this body to another model must drop it.
   thinking: { type: "between_tools" },
   // Anthropic's recommended starting point for content generation; set explicitly
   // because Sonnet 5.5's effort levels are recalibrated vs. Sonnet 5 (default high).
   output_config: { effort: "low" },
   ```
3. Keep the `stop_reason === "refusal"` throw as-is. Sonnet 5.5 adds refusal categories
   (`general_harms` among them) that server-side fallback won't retry. The existing throw → circuit
   breaker → failover-prompt path is the intended handling.
4. The text-delta loop only yields `text_delta`, so any `thinking` block events are already
   ignored. No change needed.
5. `evals/cases.ts`:
   - `PROVIDER_MODELS.anthropic = "claude-sonnet-5-5"`.
   - `PROVIDER_REQUEST_PARAMS.anthropic = { thinking: { type: "between_tools" }, output_config: { effort: "low" } }`.

---

## Step 5 — OpenAI adapter → GPT-6 Luna (part of commit C)

File: `src/lib/providers/openai.ts`

1. `const OPENAI_MODEL = "gpt-6-luna";`. Rewrite the comment above it:
   - It was verified (date) at $0.10 / $0.50, or Gate 0's numbers.
   - It mirrors the Sonnet choice.
   - The old `gpt-5-nano` / `gpt-5` cheaper and pricier pointers are no longer accurate. Remove
     them rather than guessing new ones.
2. `reasoning_effort: "low"` → `"none"` (or `"low"` if Gate 0 showed `none` is rejected). Rewrite
   the comment: GPT-6 Luna defaults to `medium` reasoning. Reasoning tokens count against
   `max_completion_tokens`. `none` removes the empty-paragraph failure that `gpt-5-mini` hit at
   600 tokens (see `constants.ts`).
3. `displayName: "GPT-5 mini (OpenAI)"` → `"GPT-6 Luna (OpenAI)"`. `splitDisplayName` parses the
   `Name (Vendor)` shape, so keep that shape.
4. Usage and caching code needs no change, *unless* Gate 0 showed `cached_tokens` is absent. In
   that case the existing `?? 0` / `undefined` handling already covers it; just confirm with a test
   run.
5. `evals/cases.ts`:
   - `PROVIDER_MODELS.openai = "gpt-6-luna"`.
   - `PROVIDER_REQUEST_PARAMS.openai = { reasoning_effort: "none" }` (or `"low"`).
6. If Gate 0 showed `chunk.model` comes back dated in a format other than `-YYYY-MM-DD`, extend the
   normalisation regex in **both** `pricing.ts` `normalizeModelId` and `evals/record.ts` (they must
   agree), and add a pricing test for the observed format.

### Display-name fallout (same commit)

- `src/lib/story/streamGeneration.test.ts` (2 occurrences of `"GPT-5 mini (OpenAI)"`) → new name.
- `e2e/specs/provider-failure.spec.ts`: lines 115–133. Update `/Use GPT-5 mini/` →
  `/Use GPT-6 Luna/`, `toContainText("GPT-5 mini")` → `"GPT-6 Luna"`, and the comment.
- **Visual snapshots.** `e2e/specs/visual.spec.ts-snapshots/` includes the `home` and `start-voice`
  screens, which likely render provider names.
  - Run the visual spec. If it fails *only* on the name change, regenerate the baselines with the
    **`Update visual snapshots`** GitHub workflow (`.github/workflows/visual-snapshots.yml`,
    `workflow_dispatch`, run on this branch). Never generate them locally (see `e2e/README.md`).
  - Any visual diff other than the provider name → **STOP**.
- `docs/adr/README.md` line 17's one-line summary of ADR 0002 stays (it's history). Step 7 adds the
  new ADR to the index.

---

## Step 6 — Record the new generators, compare against Step 3's baseline (commit C: "feat(providers): claude-sonnet-5-5 and gpt-6-luna")

```bash
npm run eval:record          # fixtures + judgements for the new generators (rubric v2, new judge)
npm run eval:live            # live run, drift checked against commit B's baseline — do NOT write yet
```

Acceptance, judged on the `eval:live` report:

- All structural checks pass for `anthropic` and `openai`: one paragraph, no meta-commentary, the
  metadata header on the kickoff case, and the 60–220 word band.
- Every `safety` score = 5, and every adversarial `injection_resisted` = true.
- No drift failure on `single_turn` or `continuity` for either swapped provider.

If a provider fails acceptance, apply its **one** allowed fallback, re-run `eval:record` and
`eval:live`, and note it in the PR:

- **Sonnet 5.5:** effort `low` → `medium`. Update `anthropic.ts` and `PROVIDER_REQUEST_PARAMS`
  together.
- **GPT-6 Luna:** `reasoning_effort` `none` → `low`. If paragraphs come back empty with
  `finish_reason: "length"` at `low`, that is the reasoning-budget problem. **STOP**; don't raise
  `MAX_OUTPUT_TOKENS` on your own.

Still failing after the fallback → **STOP** and report the per-case scores. Don't swap to a
different model.

Once acceptance passes:

```bash
npm run eval:live -- --write-baseline
npm run eval
```

Commit the adapter changes, `evals/cases.ts`, the display-name fallout, `evals/fixtures/**`,
`evals/judgements/**` and `evals/baseline.json`.

---

## Step 7 — Docs (commit D: "docs(adr): 0050 model refresh — Sonnet 5.5, GPT-6 Luna, Opus 5.5 judge")

1. New `docs/adr/0050-model-refresh-sonnet-5-5-gpt-6-luna-opus-5-5-judge.md`, in the format of
   `docs/adr/README.md`. Check that 0050 is still the next free number. It must record:
   - **Context:** the prices before and after, and why each target.
   - **Decision:**
     - The model table.
     - `between_tools` + `low` (and why not adaptive-`low`: it keeps ADR 0002's "max_tokens caps
       prose only").
     - `reasoning_effort: "none"`.
     - Judge on adaptive thinking at `medium` with 16000 `max_tokens`, `RUBRIC_VERSION` 2.
     - No server-side fallbacks, with the reasons from §0 item 4.
     - Per-model cache rates in `pricing.ts`.
     - Request parameters now in the eval fingerprint.
     - The two-stage recording (judge first, then generators).
     - Any effort fallback Step 6 actually used.
   - **Consequences:**
     - Expected per-turn cost change.
     - `between_tools` is Sonnet-5.5-only, so any future model bump must revisit it.
     - The new refusal categories are handled by the existing failover path.
     - The GPT-6 Luna facts that were only aggregator-verified, and what Gate 0 confirmed.
2. `docs/adr/0002-provider-model-selection.md`: change the Status line to
   `Accepted. Model table superseded by ADR 0050.` This is a status-only edit, which matches how
   ADR 0033 / 0025 record supersession.
3. `docs/adr/0018-llm-evaluation-harness.md`: no edit. ADR 0050 references it. The "thinking
   disabled" description there becomes history, and 0050 states the change.
4. `docs/adr/README.md`: add the 0050 index line in the existing style.
5. `src/lib/providers/constants.ts`: the `MAX_OUTPUT_TOKENS` comment names `gpt-5-mini`
   historically. Leave the history and append one sentence: the value was re-validated with
   `gpt-6-luna` and `claude-sonnet-5-5` in ADR 0050 (only if Step 6's structural checks passed at
   1500, which they must have).

---

## Step 8 — CI parity (required before pushing; from `AGENTS.md`)

Reproduce `.github/workflows/ci.yml`'s job-level env exactly (read the workflow; don't rely on the
local shell's env). Start Postgres and the Neon HTTP proxy the way `AGENTS.md` and `README.md`
describe.

- **`build` job:**
  ```bash
  npm run lint
  npm test
  npx drizzle-kit check
  npm run test:coverage
  npm run eval
  npm run build
  ```
- **`quality` job:**
  ```bash
  npm run typecheck
  npm run test:scripts
  rm -rf .next && npm run build
  npm run bundle-budget
  ```
- **`e2e` job:** `npm run test:e2e`.

Fix anything red before pushing. Expect `npm run eval` to fail in exactly one way if you forgot a
re-record: a stale fingerprint. The fix is `npm run eval:record`, never editing a fingerprint by
hand.

---

## Step 9 — Push and PR

```bash
git push -u origin chore/model-refresh-2026-10
```

Open a PR to `main` (use a PR template if the repo has one). The body must include:

- The model table with before/after prices.
- What Gate 0 verified, with the actual responses summarised.
- Step 3's judge-only score deltas, and Step 6's generator deltas against them.
- Any effort fallback used.
- That visual snapshots were regenerated via the workflow, if they were.

Then follow the repo's PR-driving rules (`.claude/skills/steward` or `babysit` if present).

---

## Stop conditions (report to the user; don't improvise)

- A key is missing, or `gpt-6-luna` 404s or shows as deprecated.
- Prices can't be verified live, or differ materially from §0.
- Making the SDK types work requires a major-version upgrade.
- The judge swap alone (Step 3) moves any safety score or `injection_resisted` result.
- A generator still fails acceptance after its one allowed fallback.
- A visual-snapshot diff that isn't just the provider name.
- Anything requiring a change to `MAX_OUTPUT_TOKENS`, `CONTEXT_WINDOW_CHAR_BUDGET`, the system
  prompt in `prompt.ts`, or the rubric text in `rubric.ts`. All of these are out of scope.

## Out of scope

- OpenRouter / Meta model changes.
- Haiku 5.5, Opus 5.5 or Fable for generation.
- Adaptive thinking for generation.
- Per-message effort, task budgets, server-side fallbacks.
- Any UI change beyond the display-name string.
- `graphify update .` (a manual, explicit ask per `AGENTS.md`).

## Rollback

Each provider's model is one constant plus one `PROVIDER_REQUEST_PARAMS` / `PROVIDER_MODELS` entry.
Reverting commit C restores the old generators. Their fixtures, judgements and baseline (under the
new judge) are exactly commit B's, so the revert leaves `npm run eval` green. Reverting B as well
restores the old judge.

## Sources

- Anthropic pricing (verified live 2026-10-27): https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic model-migration guide (Sonnet 5.5 / Opus 5.5 sections): bundled `claude-api` skill, `shared/model-migration.md`
- GPT-6 Luna model page (seen via search snippet only): https://developers.openai.com/api/docs/models/gpt-6-luna.md
- GPT-6 Luna parameters (third party, includes the unconfirmed deprecation flag): https://modelparams.dev/models/openai/gpt-6-luna
- GPT-6 Luna pricing (third party): https://go.tabbit.ai/blog/gpt-luna-6-pricing, https://www.vakati-tech.ai/models/openai-gpt-6-luna
- GPT-6 Luna as the replacement for retiring 2027 models (third party): https://www.layer3labs.io/guides/openai-deprecated-models, https://github.com/llm-exe/llm-exe/issues/906
