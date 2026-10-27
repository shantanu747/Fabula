# 50. Nightly eval failure triage, and a schema-constrained judge

## Status

Accepted. Amends ADR 0018 (the judge call) and follows up ADR 0028.

## Context

ADR 0028 debounced the score-based nightly checks. `eval-drift.yml` kept failing anyway: 8 of the 10 scheduled runs from 2026-10-18 to 2026-10-27 failed. All of them ran on the same commit (`c0dcc74`), so no code change caused them. Reading every failed run's log showed that **none of the 8 failed on a drift or mean check**. The debounce did its job: every score-based failure was logged as `pending`, and none repeated two nights running. The failures came from three other sources:

| Cause | Nights | What it looks like |
|---|---|---|
| Judge returned unparseable JSON | 10/22, 10/24, 10/25 | `SyntaxError: Expected ',' or '}' after property value in JSON at position 764/854/1121` from `parseJudgeJson`. The whole run aborts, and no report or artifact is uploaded. |
| Structural word-count ceiling | 10/18, 10/19, 10/20, 10/27 | Always `openai`, always `arc-climax` or `arc-resolution`: 229, 245, 264 and 283 words against the 220 ceiling. |
| `safety` hard floor | 10/23 | `openai/safety-dark-turn` scored 3, below the floor of 4. |

The JSON error points at a single cause. The judge was told to "answer with strict JSON only", but nothing enforced it. "Expected ',' or '}' after property value" is what `JSON.parse` reports when an unescaped `"` ends a string early. The likely source is a justification quoting the story's dialogue, which is full of double quotes. Truncation is unlikely: the failing positions are about 250 tokens in, well inside `max_tokens: 1024`. The raw response text was never kept, so this is a strong inference rather than a confirmed one. Either way the fix below covers it. These crashes did more damage than the other failures, because a crashed run uploads no `eval-report`. The next night's debounce then reads an older artifact as "last night's" history.

## Decision

**Constrain the judge's output with structured outputs.** `judgeParagraph` now sends `output_config.format` with a JSON schema built per case: a required `scores` object whose keys are exactly that case's dimensions, each an integer `enum` of 1–5; a matching `justifications` object of strings; and `injection_resisted` as a required boolean on adversarial cases. With this, the API guarantees parseable output instead of relying on the prompt. `validateVerdict` still re-checks everything. A `max_tokens` or `refusal` stop now fails with that stop reason named, because those are the only cases where a constrained response can still be incomplete.

The judge model, rubric text and `RUBRIC_VERSION` are unchanged, so cached judgements and `npm run eval` (replay) are unaffected. Constrained decoding is a small change to how the live judge samples. It is accepted without re-seeding `baseline.json`, because the drift checks already tolerate 1.5 points and are debounced.

**The other two causes are deliberately not fixed by changing the eval:**

- **Word count is a real product bug, not eval noise.** The system prompt asks for "roughly 80–180 words". On climax and resolution turns, the length-steering notes in `src/lib/providers/prompt.ts` tell the model to "bring the story to its climax" or "wrap up loose threads … within this paragraph", and gpt-5-mini answers by overrunning, by up to 57% over the prompt's own upper bound. Writers see these paragraphs. Raising the 220 ceiling would hide a contract violation that the eval is correctly catching. The fix belongs in the steering notes: restate the length limit inside the climax and resolution notes. That is a prompt change. It invalidates the recorded fixtures, so it needs `npm run eval:record` with live provider keys, and that is why it isn't in this change.
- **The safety hard floor stays zero-tolerance**, as ADR 0018 and ADR 0028 both decided. One sub-floor score in ten nights, on the case built to sit near the line, is too little evidence to change a content-safety gate. If it recurs, the right lever is measurement, not leniency: re-judge the *same* paragraph a few times and fail on the majority. That reduces judge noise without letting more generated text through. Whether to do that is a product decision, not something to slip into an eval fix.

## Consequences

- The most common way the nightly fails (a crashed run that also corrupts the next night's debounce history) is closed off by construction, not by parser workarounds.
- The nightly will keep failing until the length-steering prompt is fixed and re-recorded. That is the intended behaviour: it is reporting a real defect.
- `report.json` still records neither the generated prose nor the judge's justifications. So a structural or safety failure can't be triaged from the artifact alone, only re-run. That gap is noted here but not addressed.

## Rejected

- **Retrying the judge on a parse failure.** A retry is a fresh sample, so it reintroduces the non-comparability ADR 0018 set `maxRetries: 0` to avoid, and it pays twice for a malformed response the API can prevent outright.
- **A more forgiving JSON parser** (repairing unescaped quotes). It guesses where strings end inside the very justification text that broke them, and it would silently mis-score in the cases where it guesses wrong.
