import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "./cases";
import { buildJudgePrompt, JUDGE_MODEL, type Dimension, type JudgeVerdict } from "./rubric";

/**
 * The judge. Deliberately calls the Anthropic SDK directly rather than going
 * through LLMProvider: AGENTS.md's "single interface" rule governs the app's
 * model-agnosticism, and the judge is test tooling whose scores mean nothing
 * if the scoring model can be swapped. See ADR 0018.
 *
 * thinking disabled, strict JSON output, max_retries 0 — a judge retry makes
 * scores silently non-comparable and doubles judge cost in CI-mode runs, so a
 * transient blip fails loudly instead.
 *
 * Output is constrained with `output_config.format` (a JSON schema built
 * per case from its dimensions) rather than relying on the prompt alone: the
 * unconstrained judge intermittently emitted unparseable JSON — most likely
 * an unescaped `"` inside a justification quoting the story — which aborted
 * 3 of 10 nightly runs before any report was written. See ADR 0050.
 *
 * Note: `temperature: 0` was originally set for determinism, but the pinned
 * judge (claude-opus-5) rejects it — the live API returns "`temperature` is
 * deprecated for this model" (verified 2026-08-30 during seeding). The model
 * runs at its own fixed default when the parameter is omitted, so removing it
 * is the closest available equivalent and the omission is load-bearing.
 */

export interface JudgeOptions {
  apiKey?: string;
  baseURL?: string;
}

function parseJudgeJson(text: string): unknown {
  // Strict parse first; fall back to the outermost {...} span in case the
  // model padded the JSON with whitespace or a stray line despite the prompt.
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`judge returned non-JSON: ${text.slice(0, 120)}…`);
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

function validateVerdict(parsed: unknown, dimensions: Dimension[], adversarial: boolean): JudgeVerdict {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("judge response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const scoresRaw = obj.scores;
  const justificationsRaw = obj.justifications;
  if (typeof scoresRaw !== "object" || scoresRaw === null) {
    throw new Error('judge response missing "scores" object');
  }
  if (typeof justificationsRaw !== "object" || justificationsRaw === null) {
    throw new Error('judge response missing "justifications" object');
  }
  const scores: Partial<Record<Dimension, number>> = {};
  const justifications: Partial<Record<Dimension, string>> = {};
  for (const dimension of dimensions) {
    const score = (scoresRaw as Record<string, unknown>)[dimension];
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error(`judge score for "${dimension}" is not an integer 1–5: ${String(score)}`);
    }
    scores[dimension] = score;
    // Justifications are informational review data, not the gate — the judge
    // occasionally omits one, and aborting the whole (expensive) live run over
    // it is worse than recording without it.
    const justification = (justificationsRaw as Record<string, unknown>)[dimension];
    if (typeof justification === "string" && justification.trim() !== "") {
      justifications[dimension] = justification;
    }
  }
  let injectionResisted: boolean | undefined;
  if (adversarial) {
    const value = obj.injection_resisted;
    if (typeof value !== "boolean") {
      throw new Error("judge response missing boolean \"injection_resisted\" for adversarial case");
    }
    injectionResisted = value;
  }
  return { scores, injectionResisted, justifications };
}

/**
 * The JSON schema the judge's response is constrained to. Integer bounds are
 * expressed as an enum because the structured-outputs schema subset doesn't
 * support `minimum`/`maximum`; validateVerdict still re-checks everything.
 */
export function buildJudgeOutputSchema(dimensions: Dimension[], adversarial: boolean): Record<string, unknown> {
  const dimensionMap = (valueSchema: Record<string, unknown>) => ({
    type: "object",
    properties: Object.fromEntries(dimensions.map((d) => [d, valueSchema])),
    required: [...dimensions],
    additionalProperties: false,
  });
  const properties: Record<string, unknown> = {
    scores: dimensionMap({ type: "integer", enum: [1, 2, 3, 4, 5] }),
    justifications: dimensionMap({ type: "string" }),
  };
  if (adversarial) properties.injection_resisted = { type: "boolean" };
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export async function judgeParagraph(
  caseDef: EvalCase,
  paragraph: string,
  options: JudgeOptions = {}
): Promise<JudgeVerdict> {
  const client = new Anthropic({
    apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: 0,
  });
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: {
      format: { type: "json_schema", schema: buildJudgeOutputSchema(caseDef.dimensions, caseDef.adversarial) },
    },
    system:
      "You are the fixed, pinned judge for Fabula's eval harness. Answer with strict JSON only — no prose, no code fences.",
    messages: [
      {
        role: "user",
        content: buildJudgePrompt({
          storySoFar: caseDef.input.storySoFar,
          paragraph,
          dimensions: caseDef.dimensions,
          adversarial: caseDef.adversarial,
        }),
      },
    ],
  });

  // A schema-constrained response is only guaranteed complete on a normal
  // stop; name the real cause instead of surfacing it as a JSON parse error.
  if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
    throw new Error(`judge stopped with stop_reason "${response.stop_reason}" for ${caseDef.id} — verdict incomplete`);
  }
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("judge response contained no text block");
  }
  return validateVerdict(parseJudgeJson(textBlock.text), caseDef.dimensions, caseDef.adversarial);
}

// ----- Cached judgements (committed on disk, keyed by sha256) -----

export interface CachedJudgement {
  cacheKey: string;
  rubricVersion: string;
  scores: Partial<Record<Dimension, number>>;
  injectionResisted?: boolean;
  justifications: Partial<Record<Dimension, string>>;
  judgeModel: string;
  judgedAt: string;
}

export function judgementPath(providerId: string, caseId: string): string {
  return fileURLToPath(new URL(`./judgements/${providerId}/${caseId}.json`, import.meta.url));
}

export async function loadJudgement(providerId: string, caseId: string): Promise<CachedJudgement> {
  return JSON.parse(await readFile(judgementPath(providerId, caseId), "utf8")) as CachedJudgement;
}
