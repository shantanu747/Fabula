import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTapingFetch } from "../test-support/mock-provider/record";
import { extractInventedMetadata } from "@/lib/providers/prompt";
import type { InventedMetadata } from "@/lib/providers/types";
import { caseById, PR_MATRIX, PROVIDER_MODELS, type EvalCase, type ProviderId } from "./cases";
import { buildEvalPayload } from "./cases";
import { fingerprintPayload, judgementCacheKey } from "./fingerprint";
import { judgeParagraph } from "./judge";
import { decodeRawSse, fixturePath, vendorForProvider } from "./replay";
import { checkStructural } from "./structural";
import { JUDGE_MODEL, RUBRIC_VERSION, type Dimension, type JudgeVerdict } from "./rubric";

/**
 * `npm run eval:record` — re-records fixtures and judgements for the PR matrix
 * against the live providers (19 generations + 19 judge calls — real money;
 * this is a deliberate local act, never CI; docs/plans/v3/01).
 *
 * The live request is driven by the real vendor SDK with a taping fetch
 * injected, so the request build (headers, JSON body, model params) is exactly
 * the SDK's own and only the raw SSE response body is persisted. Request
 * headers — which carry the API key — never leave the process.
 */

export interface JudgementFile {
  cacheKey: string;
  rubricVersion: string;
  scores: Partial<Record<Dimension, number>>;
  injectionResisted?: boolean;
  justifications: Partial<Record<Dimension, string>>;
  judgeModel: string;
  judgedAt: string;
}

export interface LiveCapture {
  rawSse: string;
  /** Decoded text chunks as a joined string — what the model emitted verbatim. */
  generatedText: string;
  /** Prose after metadata-header extraction (what the app displays). */
  prose: string;
  metadata: InventedMetadata | undefined;
  model: string;
}

async function* chunkStream(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

/** Reuse the production header-stripper so recording and replay agree on what prose is. */
async function extractProse(caseDef: EvalCase, chunks: string[]): Promise<{ prose: string; metadata: InventedMetadata | undefined }> {
  const iterator = extractInventedMetadata(chunkStream(chunks), caseDef.expectMetadataHeader);
  let prose = "";
  let metadata: InventedMetadata | undefined;
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) {
      metadata = value;
      break;
    }
    prose += value;
  }
  return { prose, metadata };
}

/**
 * Drive one live generation, mirroring the corresponding adapter's request
 * params exactly (thinking disabled, system/messages from buildEvalPayload).
 */
export async function captureLiveGeneration(
  providerId: ProviderId,
  caseDef: EvalCase
): Promise<LiveCapture> {
  const taping = createTapingFetch();
  const payload = buildEvalPayload(providerId, caseDef.input);

  if (providerId === "anthropic") {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: taping.fetchFn });
    const stream = client.messages.stream({
      model: payload.model,
      max_tokens: payload.maxTokens,
      thinking: { type: "disabled" },
      system: payload.systemPrompt,
      messages: payload.messages,
    });
    for await (const event of stream) {
      // Consume exactly like the adapter so a mid-stream failure surfaces here.
      void event;
    }
    await stream.finalMessage();
  } else if (providerId === "openai") {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: taping.fetchFn });
    const stream = await client.chat.completions.create({
      model: payload.model,
      max_completion_tokens: payload.maxTokens,
      // Must mirror src/lib/providers/openai.ts: without this, gpt-5-mini's
      // default reasoning exhausts max_completion_tokens and returns an empty
      // completion on longer contexts.
      reasoning_effort: "low",
      stream: true,
      messages: [{ role: "system", content: payload.systemPrompt }, ...payload.messages],
    });
    for await (const chunk of stream) {
      void chunk;
    }
  } else {
    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      fetch: taping.fetchFn,
    });
    const stream = await client.chat.completions.create({
      model: payload.model,
      max_tokens: payload.maxTokens,
      stream: true,
      messages: [{ role: "system", content: payload.systemPrompt }, ...payload.messages],
    });
    for await (const chunk of stream) {
      void chunk;
    }
  }

  const rawSse = taping.lastBody();
  const { chunks, model } = decodeRawSse(vendorForProvider(providerId), rawSse);
  // Providers differ in how they echo the model: Anthropic returns the alias
  // verbatim ("claude-sonnet-5"), while OpenAI returns the dated snapshot it
  // resolved the alias to ("gpt-5-mini" -> "gpt-5-mini-2025-08-07"). Strip a
  // trailing dated suffix before comparing so a resolution is not a failure,
  // but a genuinely different model still is.
  const expected = PROVIDER_MODELS[providerId];
  const resolved = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (resolved !== expected) {
    // The eval table must track the adapters' model constants, otherwise the
    // fingerprint hashes a request the app doesn't quite build.
    throw new Error(
      `live ${providerId} response carried model "${model}" but evals/cases.ts says "${expected}" — update PROVIDER_MODELS in the same commit as the adapter change`
    );
  }
  const { prose, metadata } = await extractProse(caseDef, chunks);
  return { rawSse, generatedText: chunks.join(""), prose, metadata, model };
}

async function writeFixture(providerId: ProviderId, caseDef: EvalCase, capture: LiveCapture): Promise<void> {
  const fingerprint = fingerprintPayload(buildEvalPayload(providerId, caseDef.input));
  const fixture = {
    caseId: caseDef.id,
    providerId,
    model: capture.model,
    requestFingerprint: fingerprint,
    recordedAt: new Date().toISOString(),
    rawSse: capture.rawSse,
  };
  const path = fixturePath(providerId, caseDef.id);
  await mkdir(fileURLToPath(new URL(`./fixtures/${providerId}`, import.meta.url)), { recursive: true });
  await writeFile(path, JSON.stringify(fixture, null, 2) + "\n", "utf8");
}

async function writeJudgement(
  providerId: ProviderId,
  caseDef: EvalCase,
  generatedText: string,
  verdict: JudgeVerdict
): Promise<void> {
  const judgement: JudgementFile = {
    cacheKey: judgementCacheKey(generatedText, caseDef.id, RUBRIC_VERSION),
    rubricVersion: RUBRIC_VERSION,
    scores: verdict.scores,
    ...(verdict.injectionResisted !== undefined ? { injectionResisted: verdict.injectionResisted } : {}),
    justifications: verdict.justifications,
    judgeModel: JUDGE_MODEL,
    judgedAt: new Date().toISOString(),
  };
  const path = fileURLToPath(new URL(`./judgements/${providerId}/${caseDef.id}.json`, import.meta.url));
  await mkdir(fileURLToPath(new URL(`./judgements/${providerId}`, import.meta.url)), { recursive: true });
  await writeFile(path, JSON.stringify(judgement, null, 2) + "\n", "utf8");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  const missingKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"].filter(
    (name) => !process.env[name]
  );
  if (missingKeys.length > 0) {
    console.error(`eval:record needs live provider keys; missing: ${missingKeys.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Recording ${PR_MATRIX.length} entries (PR matrix) + ${PR_MATRIX.length} judge calls...\n`);

  await mapWithConcurrency(PR_MATRIX, 3, async ({ providerId, caseId }) => {
    const caseDef = caseById(caseId);
    process.stdout.write(`  ${providerId}/${caseId} … `);
    const capture = await captureLiveGeneration(providerId, caseDef);
    await writeFixture(providerId, caseDef, capture);

    const structural = checkStructural(capture.prose, {
      expectMetadataHeader: caseDef.expectMetadataHeader,
      metadata: capture.metadata,
    });
    if (!structural.passed) {
      // Not fatal to recording: the point of the fixture is to expose it.
      console.warn(`\n    [warn] structural: ${structural.failures.join("; ")}`);
    }

    const verdict = await judgeParagraph(caseDef, capture.prose);
    await writeJudgement(providerId, caseDef, capture.generatedText, verdict);
    console.log(`ok (safety ${verdict.scores.safety}, single_turn ${verdict.scores.single_turn})`);
  });

  console.log("\nFixtures and judgements written. Run `npm run eval` to replay.");
}

// Only run when invoked directly (`npm run eval:record`) — run.ts imports
// captureLiveGeneration from here without wanting a recording to fire.
if (process.argv[1]?.endsWith("record.ts")) {
  main().catch((err) => {
    console.error("eval:record failed:", err);
    process.exitCode = 1;
  });
}
