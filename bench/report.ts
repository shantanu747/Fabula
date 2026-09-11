/**
 * Pure percentile arithmetic and report formatting for the capacity benchmark
 * harness (bench/harness.ts). No I/O, no timers — see docs/plans/v4/01-load-harness.md's
 * "This file holds the only logic worth unit testing" and bench/report.test.ts.
 */

/**
 * Linear-interpolation percentile (the "PERCENTILE.INC" definition): for `n`
 * sorted samples, the p-th percentile sits at rank `p * (n - 1)`, interpolating
 * between the two closest samples when that rank isn't a whole number.
 *
 * With fewer than 100 samples, p99's rank sits close to (but usually not
 * exactly at) the last index — e.g. 10 samples puts p99 at rank 8.91, 91% of
 * the way from the 9th to the 10th value. That's correct, not a bug: it is
 * still worth a named test (see report.test.ts) because a naive
 * `values[Math.floor(p * n)]` is off by one and silently returns `undefined`
 * at p=1 for exactly this input size.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new Error("percentile: no samples");
  }
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`percentile: p must be within [0, 1], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];

  const frac = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

/** One completed (or failed) /api/generate call, as observed by the harness. */
export interface TurnSample {
  writerId: number;
  turn: number;
  /** Undefined when no body byte ever arrived (rejected before streaming, e.g. 429/502/409). */
  ttftMs?: number;
  totalMs: number;
  status: number;
  storySoFarBytes: number;
}

export interface RoundtripCount {
  label: string;
  select: number;
  insert: number;
  update: number;
  execute: number;
  total: number;
}

export interface CostSummary {
  stories: number;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunMetrics {
  writers: number;
  turns: number;
  rampMs: number;
  mockChunkDelayMs: number;
  identity: "shared-authenticated";
  wallMs: number;
  samples: TurnSample[];
  roundTrips: RoundtripCount[];
  cost?: CostSummary;
}

export interface RunSummary {
  ttftMs: Percentiles | undefined;
  turnDurationMs: Percentiles | undefined;
  storySoFarBytes: Percentiles | undefined;
  throughputPerSec: number;
  totalCalls: number;
  successCount: number;
  errorsByStatus: Record<number, number>;
}

/** percentiles() over `values`, or undefined for an empty run — a run with zero
 *  samples has nothing to report a distribution over, and that's a distinct,
 *  representable state rather than an error. */
function percentilesOrUndefined(values: readonly number[]): Percentiles | undefined {
  return values.length > 0 ? percentiles(values) : undefined;
}

export function summarize(metrics: RunMetrics): RunSummary {
  const { samples, wallMs } = metrics;
  const successes = samples.filter((s) => s.status === 200);
  const ttfts = successes.map((s) => s.ttftMs).filter((v): v is number => v !== undefined);

  const errorsByStatus: Record<number, number> = {};
  for (const s of samples) {
    if (s.status !== 200) errorsByStatus[s.status] = (errorsByStatus[s.status] ?? 0) + 1;
  }

  return {
    ttftMs: percentilesOrUndefined(ttfts),
    // Successes only, like ttftMs — "to stream completion" only means something
    // for a call that actually streamed. A 429/502/409 fails fast, before any
    // provider or DB-persistence work happens, and mixing that latency in would
    // pull this toward "how fast the rate limiter rejects things" rather than
    // "how long a real turn takes" as writer/turn counts rise and rejections
    // dominate the sample.
    turnDurationMs: percentilesOrUndefined(successes.map((s) => s.totalMs)),
    // Unlike the two above, this one IS over every call: the client uploads
    // storySoFar before learning whether the server accepts the turn, so upload
    // cost is real regardless of outcome.
    storySoFarBytes: percentilesOrUndefined(samples.map((s) => s.storySoFarBytes)),
    throughputPerSec: wallMs > 0 ? successes.length / (wallMs / 1000) : 0,
    totalCalls: samples.length,
    successCount: successes.length,
    errorsByStatus,
  };
}

function fmtMs(n: number): string {
  return `${n.toFixed(0)}ms`;
}

function fmtPctWith(p: Percentiles | undefined, unit: (n: number) => string): string {
  if (!p) return "n/a (no samples)";
  return `p50=${unit(p.p50)} p95=${unit(p.p95)} p99=${unit(p.p99)}`;
}

function fmtPct(p: Percentiles | undefined): string {
  return fmtPctWith(p, fmtMs);
}

function fmtBytesPct(p: Percentiles | undefined): string {
  return fmtPctWith(p, (n) => `${n.toFixed(0)}B`);
}

export function formatTable(metrics: RunMetrics, summary: RunSummary): string {
  const lines: string[] = [];
  lines.push("=== Fabula capacity benchmark ===");
  lines.push(
    `writers=${metrics.writers} turns=${metrics.turns} ramp=${metrics.rampMs}ms ` +
      `mock-chunk-delay=${metrics.mockChunkDelayMs}ms identity=${metrics.identity}`
  );
  lines.push("");
  lines.push(`TTFT:          ${fmtPct(summary.ttftMs)}`);
  lines.push(`Turn duration: ${fmtPct(summary.turnDurationMs)}`);
  lines.push(`storySoFar bytes uploaded: ${fmtBytesPct(summary.storySoFarBytes)}`);
  lines.push(`Throughput: ${summary.throughputPerSec.toFixed(2)} completed turns/sec`);
  lines.push(`Calls: ${summary.totalCalls} total, ${summary.successCount} succeeded (200)`);
  const statusEntries = Object.entries(summary.errorsByStatus);
  if (statusEntries.length > 0) {
    lines.push(
      "Errors by status: " +
        statusEntries
          .map(([status, count]) => `${status}=${count}`)
          .join(", ")
    );
  } else {
    lines.push("Errors by status: none");
  }
  lines.push("");
  lines.push("DB round trips per operation (sequential phase, one call at a time):");
  for (const rt of metrics.roundTrips) {
    lines.push(
      `  ${rt.label}: total=${rt.total} (select=${rt.select} insert=${rt.insert} ` +
        `update=${rt.update} execute=${rt.execute})`
    );
  }
  if (metrics.cost) {
    lines.push("");
    lines.push(
      `Cost: ${metrics.cost.stories} stories, ${metrics.cost.events} generation_event rows, ` +
        `${metrics.cost.inputTokens} input tokens, ${metrics.cost.outputTokens} output tokens, ` +
        `$${metrics.cost.costUsd.toFixed(4)} total`
    );
  }
  return lines.join("\n");
}

export function toJson(metrics: RunMetrics, summary: RunSummary): string {
  return JSON.stringify({ metrics, summary }, null, 2);
}
