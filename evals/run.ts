import { startMockProvider } from "../test-support/mock-provider/server";
import type { MockProvider } from "../test-support/mock-provider/types";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JUDGE_MODEL, RUBRIC_VERSION } from "./rubric";
import type { Dimension } from "./rubric";
import { caseById, FULL_MATRIX, PR_MATRIX, type MatrixEntry } from "./cases";
import { judgementCacheKey } from "./fingerprint";
import { judgeParagraph, loadJudgement } from "./judge";
import { captureLiveGeneration } from "./record";
import {
  checkFixtureStaleness,
  decodeRawSse,
  loadFixture,
  replayFixture,
  vendorForProvider,
} from "./replay";
import { checkStructural } from "./structural";
import {
  evaluateDrift,
  evaluateEntries,
  loadBaseline,
  loadThresholds,
  writeReports,
  type Baseline,
  type EvalEntry,
} from "./report";

/**
 * evals/run.ts — the standalone runner (docs/plans/v3/01).
 *
 *   tsx evals/run.ts                         replay, PR matrix (same flow as `npm run eval`)
 *   tsx evals/run.ts --live --full           nightly: live calls, live judge, drift vs baseline
 *   tsx evals/run.ts --live --full --write-baseline   refresh evals/baseline.json
 *
 * Replay mode never spends tokens. Live mode requires all three provider keys
 * and fails loudly before spending anything if any is missing.
 */

interface CliArgs {
  live: boolean;
  full: boolean;
  writeBaseline: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    live: argv.includes("--live"),
    full: argv.includes("--full"),
    writeBaseline: argv.includes("--write-baseline"),
  };
}

/** Assemble one matrix entry from a committed fixture + cached judgement. */
async function collectReplayEntry(
  mock: MockProvider,
  { providerId, caseId }: MatrixEntry
): Promise<EvalEntry> {
  const caseDef = caseById(caseId);
  const fixture = await loadFixture(providerId, caseId);
  const { stale, currentFingerprint } = checkFixtureStaleness(fixture, caseDef);
  if (stale) {
    throw new Error(
      `fixture stale for ${caseId}/${providerId}: run npm run eval:record\n` +
        `  recorded: ${fixture.requestFingerprint}\n  current:  ${currentFingerprint}`
    );
  }

  const { prose, metadata } = await replayFixture(fixture, caseDef, mock);
  const structural = checkStructural(prose, {
    expectMetadataHeader: caseDef.expectMetadataHeader,
    metadata,
  });

  const { chunks } = decodeRawSse(vendorForProvider(providerId), fixture.rawSse);
  const judgement = await loadJudgement(providerId, caseId);
  const expectedKey = judgementCacheKey(chunks.join(""), caseId, RUBRIC_VERSION);
  if (judgement.cacheKey !== expectedKey || judgement.rubricVersion !== RUBRIC_VERSION) {
    throw new Error(
      `judgement stale for ${caseId}/${providerId}: run npm run eval:record\n` +
        `  recorded: ${judgement.cacheKey}\n  expected: ${expectedKey} (rubric v${RUBRIC_VERSION})`
    );
  }

  return {
    providerId,
    caseId,
    structuralPassed: structural.passed,
    structuralFailures: structural.failures,
    scores: judgement.scores,
    ...(judgement.injectionResisted !== undefined
      ? { injectionResisted: judgement.injectionResisted }
      : {}),
  };
}

/** One live generation + structural check + live judge. */
async function collectLiveEntry({ providerId, caseId }: MatrixEntry): Promise<EvalEntry> {
  const caseDef = caseById(caseId);
  const capture = await captureLiveGeneration(providerId, caseDef);
  const structural = checkStructural(capture.prose, {
    expectMetadataHeader: caseDef.expectMetadataHeader,
    metadata: capture.metadata,
  });
  const verdict = await judgeParagraph(caseDef, capture.prose);
  return {
    providerId,
    caseId,
    structuralPassed: structural.passed,
    structuralFailures: structural.failures,
    scores: verdict.scores,
    ...(verdict.injectionResisted !== undefined ? { injectionResisted: verdict.injectionResisted } : {}),
  };
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

async function runReplay(matrix: MatrixEntry[]): Promise<EvalEntry[]> {
  // Adapters memoize their SDK client and read the base-URL env var once per
  // process — the mock URL is installed before any generation happens, and
  // nothing in this process ever points at a live endpoint.
  const mock = await startMockProvider();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.OPENAI_BASE_URL = mock.url;
  process.env.OPENROUTER_BASE_URL = mock.url;
  // The SDKs refuse to construct without a key even though the mock ignores it.
  process.env.ANTHROPIC_API_KEY ??= "eval-replay-key";
  process.env.OPENAI_API_KEY ??= "eval-replay-key";
  process.env.OPENROUTER_API_KEY ??= "eval-replay-key";
  try {
    const entries: EvalEntry[] = [];
    for (const entry of matrix) {
      entries.push(await collectReplayEntry(mock, entry));
    }
    return entries;
  } finally {
    await mock.stop();
  }
}

function requiredKeysFor(matrix: MatrixEntry[]): string[] {
  const providers = new Set(matrix.map((entry) => entry.providerId));
  // The judge always needs Anthropic, regardless of matrix composition.
  const keys = ["ANTHROPIC_API_KEY"];
  if (providers.has("openai")) keys.push("OPENAI_API_KEY");
  if (providers.has("openrouter")) keys.push("OPENROUTER_API_KEY");
  return keys;
}

async function runLive(matrix: MatrixEntry[], writeBaseline: boolean): Promise<{ entries: EvalEntry[]; failures: string[] }> {
  const missing = requiredKeysFor(matrix).filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `eval --live needs provider keys; missing: ${missing.join(", ")} — refusing to run ` +
        `(a silently green run is worse than a failed one)`
    );
  }

  const entries = await mapWithConcurrency(matrix, 3, async (entry) => {
    process.stdout.write(`  ${entry.providerId}/${entry.caseId} …\n`);
    return collectLiveEntry(entry);
  });

  const thresholds = await loadThresholds();
  const failures = evaluateEntries(entries, thresholds);

  if (writeBaseline) {
    const baseline = buildBaseline(entries);
    const path = fileURLToPath(new URL("./baseline.json", import.meta.url));
    await writeFile(path, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log("wrote evals/baseline.json");
  } else {
    const baseline = await loadBaseline();
    if (!baseline) {
      throw new Error("evals/baseline.json not found — run npm run eval:live --write-baseline first");
    }
    failures.push(...evaluateDrift(entries, baseline, thresholds.nightlyDriftTolerance));
  }

  return { entries, failures };
}

function buildBaseline(entries: EvalEntry[]): Baseline {
  const sorted = [...entries].sort((a, b) =>
    a.providerId === b.providerId
      ? a.caseId.localeCompare(b.caseId)
      : a.providerId.localeCompare(b.providerId)
  );
  const scores: Record<string, Partial<Record<Dimension, number>>> = {};
  for (const entry of sorted) {
    scores[`${entry.providerId}/${entry.caseId}`] = Object.fromEntries(
      Object.entries(entry.scores).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return { rubricVersion: RUBRIC_VERSION, judgeModel: JUDGE_MODEL, scores };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const matrix = args.full ? FULL_MATRIX : PR_MATRIX;
  const thresholds = await loadThresholds();

  let entries: EvalEntry[];
  let failures: string[];

  if (args.live) {
    console.log(
      `eval --live ${args.full ? "--full" : "(PR matrix)"}${args.writeBaseline ? " --write-baseline" : ""}: ` +
        `${matrix.length} entries, judge ${JUDGE_MODEL}`
    );
    const live = await runLive(matrix, args.writeBaseline);
    entries = live.entries;
    failures = live.failures;
  } else {
    entries = await runReplay(matrix);
    failures = evaluateEntries(entries, thresholds);
  }

  await writeReports(entries, thresholds, failures);

  if (failures.length > 0) {
    console.error(`\neval FAILED with ${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\neval passed (${entries.length} entries; see evals/report.md)`);
  }
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    console.error("eval run failed:", err);
    process.exitCode = 1;
  });
}
