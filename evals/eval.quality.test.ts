import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockProvider } from "../test-support/mock-provider/server";
import type { MockProvider } from "../test-support/mock-provider/types";
import { caseById, PR_MATRIX } from "./cases";
import { judgementCacheKey } from "./fingerprint";
import { loadJudgement } from "./judge";
import { loadThresholds, evaluateEntries, writeReports, type EvalEntry, type Thresholds } from "./report";
import {
  checkFixtureStaleness,
  decodeRawSse,
  loadFixture,
  replayFixture,
  vendorForProvider,
} from "./replay";
import { checkStructural } from "./structural";
import { RUBRIC_VERSION } from "./rubric";

/**
 * Layer 2 — output quality via recorded fixtures replayed through the real
 * adapters (docs/plans/v3/01). Free in CI: the mock server serves the recorded
 * SSE bodies and judgements come from committed cache files.
 *
 * Env setup lives in beforeAll: the adapters construct their SDK client lazily
 * and read the base-URL env vars once per process, so the mock URL must be in
 * place before the first generation of this file — and nothing in this file
 * may run before beforeAll. `pool: "forks"` keeps other files' env isolated.
 */

let mock: MockProvider;
let thresholds: Thresholds;
const entries: EvalEntry[] = [];

beforeAll(async () => {
  mock = await startMockProvider();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.OPENAI_BASE_URL = mock.url;
  process.env.OPENROUTER_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY ??= "eval-replay-key";
  process.env.OPENAI_API_KEY ??= "eval-replay-key";
  process.env.OPENROUTER_API_KEY ??= "eval-replay-key";
  thresholds = await loadThresholds();
});

afterAll(async () => {
  try {
    // writeReports is in afterAll (not the last test) so a report is written
    // even when an entry fails — the report is supposed to describe reality.
    await writeReports(entries, thresholds, evaluateEntries(entries, thresholds));
  } finally {
    await mock.stop();
  }
});

for (const { providerId, caseId } of PR_MATRIX) {
  const label = `${providerId}/${caseId}`;

  describe(`quality: ${label}`, () => {
    it("has a fixture", async () => {
      await loadFixture(providerId, caseId);
    });

    it("fixture is fresh against the current prompt payload", async () => {
      const fixture = await loadFixture(providerId, caseId);
      const { stale, currentFingerprint } = checkFixtureStaleness(fixture, caseById(caseId));
      expect(
        stale,
        `fixture stale for ${caseId}/${providerId}: run npm run eval:record\n` +
          `  recorded: ${fixture.requestFingerprint}\n  current:  ${currentFingerprint}`
      ).toBe(false);
    });

    it("produces structurally valid output", async () => {
      const caseDef = caseById(caseId);
      const fixture = await loadFixture(providerId, caseId);
      const { prose, metadata } = await replayFixture(fixture, caseDef, mock);
      const structural = checkStructural(prose, {
        expectMetadataHeader: caseDef.expectMetadataHeader,
        metadata,
      });
      expect(structural.failures, `structural failures for ${label}`).toEqual([]);
    });

    it("has a cached judgement that still matches the fixture", async () => {
      const fixture = await loadFixture(providerId, caseId);
      const { chunks } = decodeRawSse(vendorForProvider(providerId), fixture.rawSse);
      const judgement = await loadJudgement(providerId, caseId);
      const expectedKey = judgementCacheKey(chunks.join(""), caseId, RUBRIC_VERSION);
      expect(
        judgement.cacheKey === expectedKey && judgement.rubricVersion === RUBRIC_VERSION,
        `judgement stale for ${caseId}/${providerId}: run npm run eval:record\n` +
          `  recorded: ${judgement.cacheKey}\n  expected: ${expectedKey} (rubric v${RUBRIC_VERSION})`
      ).toBe(true);
    });

    it("meets the per-entry floors and collects scores", async () => {
      const caseDef = caseById(caseId);
      const fixture = await loadFixture(providerId, caseId);
      const { prose, metadata } = await replayFixture(fixture, caseDef, mock);
      const structural = checkStructural(prose, {
        expectMetadataHeader: caseDef.expectMetadataHeader,
        metadata,
      });
      const judgement = await loadJudgement(providerId, caseId);

      const entry: EvalEntry = {
        providerId,
        caseId,
        structuralPassed: structural.passed,
        structuralFailures: structural.failures,
        scores: judgement.scores,
        ...(judgement.injectionResisted !== undefined
          ? { injectionResisted: judgement.injectionResisted }
          : {}),
      };
      entries.push(entry);

      for (const [dimension, floor] of Object.entries(thresholds.hardFloors)) {
        const score = entry.scores[dimension as keyof typeof entry.scores];
        if (score !== undefined) {
          expect(score, `hard floor ${dimension} for ${label}`).toBeGreaterThanOrEqual(floor);
        }
      }
      if (caseDef.adversarial) {
        expect(entry.injectionResisted, `injection_resisted for ${label}`).toBe(true);
      }
    });
  });
}

it("aggregate: pooled means and pass-rate meet thresholds.json", () => {
  const failures = evaluateEntries(entries, thresholds);
  expect(failures, "threshold failures:\n" + failures.join("\n")).toEqual([]);
});
