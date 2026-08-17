import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Dimension } from "./rubric";
import { RUBRIC_VERSION } from "./rubric";
import type { ProviderId } from "./cases";

/**
 * Threshold evaluation + deterministic report writing (docs/plans/v3/01).
 *
 * Semantics (pinned decision): hard floors, booleans, and the structural
 * pass-rate apply per (provider, case) entry; `means` are pooled across every
 * scored entry in the executed matrix for that dimension — pooled across
 * providers, not per-provider.
 *
 * report.json must be byte-deterministic across repeated runs: stable key
 * order everywhere, entries sorted, no wall-clock timestamps or durations
 * (recordedAt/judgedAt live inside fixture/judgement files instead), and no
 * absolute paths.
 */

export interface Thresholds {
  hardFloors: Partial<Record<Dimension, number>>;
  booleans: Record<string, boolean>;
  structural: { passRate: number };
  means: Partial<Record<Dimension, number>>;
  nightlyDriftTolerance: number;
}

export interface EvalEntry {
  providerId: ProviderId;
  caseId: string;
  structuralPassed: boolean;
  structuralFailures: string[];
  scores: Partial<Record<Dimension, number>>;
  injectionResisted?: boolean;
}

export interface Baseline {
  rubricVersion: string;
  judgeModel: string;
  scores: Record<string, Partial<Record<Dimension, number>>>;
}

function evalsPath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

export async function loadThresholds(): Promise<Thresholds> {
  return JSON.parse(await readFile(evalsPath("./thresholds.json"), "utf8")) as Thresholds;
}

export async function loadBaseline(): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(evalsPath("./baseline.json"), "utf8")) as Baseline;
  } catch {
    return undefined;
  }
}

function baselineKey(providerId: string, caseId: string): string {
  return `${providerId}/${caseId}`;
}

export function meanScores(entries: EvalEntry[]): Partial<Record<Dimension, number>> {
  const sums = new Map<Dimension, { total: number; count: number }>();
  for (const entry of entries) {
    for (const [dimension, score] of Object.entries(entry.scores)) {
      const acc = sums.get(dimension as Dimension) ?? { total: 0, count: 0 };
      acc.total += score as number;
      acc.count += 1;
      sums.set(dimension as Dimension, acc);
    }
  }
  const means: Partial<Record<Dimension, number>> = {};
  for (const [dimension, { total, count }] of sums) {
    // Round to 4 decimals so report.json is byte-deterministic (no float noise).
    means[dimension] = Number((total / count).toFixed(4));
  }
  return means;
}

/** Returns human-readable failure strings; an empty array means pass. */
export function evaluateEntries(entries: EvalEntry[], thresholds: Thresholds): string[] {
  const failures: string[] = [];

  // Zero entries is not a pass: it means the matrix or fixture loading is
  // misconfigured, and a green report at that point would be a lie.
  if (entries.length === 0) {
    failures.push("no entries executed — the matrix or fixtures are misconfigured");
    return failures;
  }

  const structuralFailed = entries.filter((e) => !e.structuralPassed);
  const structuralPassRate =
    entries.length === 0 ? 0 : (entries.length - structuralFailed.length) / entries.length;
  if (structuralPassRate < thresholds.structural.passRate) {
    for (const entry of structuralFailed) {
      failures.push(
        `structural: ${entry.providerId}/${entry.caseId} — ${entry.structuralFailures.join("; ")}`
      );
    }
  }

  for (const [dimension, floor] of Object.entries(thresholds.hardFloors)) {
    for (const entry of entries) {
      const score = entry.scores[dimension as Dimension];
      if (score !== undefined && score < floor) {
        failures.push(
          `hard floor ${dimension}: ${entry.providerId}/${entry.caseId} scored ${score} (< ${floor})`
        );
      }
    }
  }

  for (const entry of entries) {
    if (entry.injectionResisted === false) {
      failures.push(`injection_resisted: ${entry.providerId}/${entry.caseId} failed to resist embedded instructions`);
    }
  }

  const means = meanScores(entries);
  for (const [dimension, threshold] of Object.entries(thresholds.means)) {
    const mean = means[dimension as Dimension];
    if (mean !== undefined && mean < threshold) {
      failures.push(`mean ${dimension}: ${mean} < ${threshold}`);
    }
  }

  return failures;
}

/** Nightly drift: any scored dimension dropping more than `tolerance` below the committed baseline. */
export function evaluateDrift(entries: EvalEntry[], baseline: Baseline, tolerance: number): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    const key = baselineKey(entry.providerId, entry.caseId);
    const baselineScores = baseline.scores[key];
    if (!baselineScores) {
      failures.push(`baseline missing for ${key} — seed it with npm run eval:live --write-baseline`);
      continue;
    }
    for (const [dimension, liveScore] of Object.entries(entry.scores)) {
      const base = baselineScores[dimension as Dimension];
      if (base !== undefined && (liveScore as number) < base - tolerance) {
        failures.push(
          `drift ${dimension}: ${key} live ${liveScore} vs baseline ${base} (tolerance ${tolerance})`
        );
      }
    }
  }
  return failures;
}

function sortEntries(entries: EvalEntry[]): EvalEntry[] {
  return [...entries].sort((a, b) =>
    a.providerId === b.providerId ? a.caseId.localeCompare(b.caseId) : a.providerId.localeCompare(b.providerId)
  );
}

function sortScores(scores: Partial<Record<Dimension, number>>): Partial<Record<Dimension, number>> {
  return Object.fromEntries(Object.entries(scores).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Writes both reports deterministically. Entries are sorted and all nested
 * maps key-sorted; nothing wall-clock or machine-local is included. Running
 * `npm run eval` twice must produce byte-identical report.json.
 */
export async function writeReports(
  entries: EvalEntry[],
  thresholds: Thresholds,
  failures: string[]
): Promise<void> {
  const sorted = sortEntries(entries);
  const report = {
    rubricVersion: RUBRIC_VERSION,
    entryCount: sorted.length,
    entries: sorted.map((entry) => ({
      providerId: entry.providerId,
      caseId: entry.caseId,
      structuralPassed: entry.structuralPassed,
      ...(entry.structuralFailures.length > 0 ? { structuralFailures: entry.structuralFailures } : {}),
      scores: sortScores(entry.scores),
      ...(entry.injectionResisted !== undefined ? { injectionResisted: entry.injectionResisted } : {}),
    })),
    means: meanScores(sorted),
    thresholds,
    failures: [...failures].sort(),
    passed: failures.length === 0,
  };
  await mkdir(evalsPath("."), { recursive: true });
  await writeFile(evalsPath("./report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(evalsPath("./report.md"), renderMarkdown(report), "utf8");
}

interface ReportShape {
  rubricVersion: string;
  entryCount: number;
  entries: Array<{
    providerId: string;
    caseId: string;
    structuralPassed: boolean;
    structuralFailures?: string[];
    scores: Partial<Record<Dimension, number>>;
    injectionResisted?: boolean;
  }>;
  means: Partial<Record<Dimension, number>>;
  failures: string[];
  passed: boolean;
}

function renderMarkdown(report: ReportShape): string {
  const dimensionSet = new Set<Dimension>();
  for (const entry of report.entries) {
    for (const dimension of Object.keys(entry.scores)) dimensionSet.add(dimension as Dimension);
  }
  const dimensions = [...dimensionSet].sort();

  const lines: string[] = [
    "# Fabula LLM eval report",
    "",
    "Generated by `npm run eval` / `npm run eval:live` — do not edit by hand.",
    "",
    `Rubric v${report.rubricVersion} · ${report.entryCount} entries · **${report.passed ? "PASS" : "FAIL"}**`,
    "",
    `| provider | case | structural | ${dimensions.join(" | ")} | injection_resisted |`,
    `|---|---|---|${dimensions.map(() => "---").join("|")}|---|`,
  ];

  for (const entry of report.entries) {
    const cells = dimensions.map((d) => String(entry.scores[d] ?? "—"));
    const structural = entry.structuralPassed
      ? "pass"
      : `fail (${entry.structuralFailures?.join("; ") ?? ""})`;
    const injection =
      entry.injectionResisted === undefined ? "—" : entry.injectionResisted ? "true" : "**false**";
    lines.push(`| ${entry.providerId} | ${entry.caseId} | ${structural} | ${cells.join(" | ")} | ${injection} |`);
  }

  lines.push("", "## Means (pooled across the executed matrix)", "");
  for (const dimension of dimensions) {
    lines.push(`- ${dimension}: ${report.means[dimension] ?? "—"}`);
  }

  if (report.failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }
  lines.push("");
  return lines.join("\n");
}
