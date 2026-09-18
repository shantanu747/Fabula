/**
 * Operational targets, as code (docs/adr/0049) — the plan's own instruction
 * that a vague target is worse than none. Every definition below carries a
 * numeric target, the window it's measured over, and a one-line rationale
 * for *why* that number, not just what it is.
 *
 * **These four targets are a provisional judgment call, not a measurement**
 * — this app has no production traffic history yet, the same gap ADR 0023
 * named when it first considered circuit breaking and `circuitBreaker.ts`'s
 * own `FAILURE_THRESHOLD` still names today. `bench/BASELINE.md` (Plan 1)
 * explicitly disclaims itself for this exact use: "use these numbers to
 * compare before/after a change measured the same way, not as a production
 * SLO" — its TTFT figures were measured against the mock provider under
 * local Postgres, not a real model's latency over Neon's managed endpoint.
 * Treat every number here the same way: a starting point to revisit once
 * real traffic exists, stated honestly rather than dressed up with false
 * precision.
 *
 * Only two of these four are actually computable today, and only from
 * `generation_event` — the durable table ADR 0022 built specifically so a
 * SQL-queryable answer to "were we meeting our own targets" would exist.
 * `scripts/slo-report.mts` is the first thing that has ever queried it for
 * that purpose. Feed p95 and availability depend on data that lives only in
 * OTel metrics/spans (an external OTLP backend), not in this app's own
 * Postgres — they're still defined here as targets, but the report script
 * says plainly that it cannot compute them, rather than fabricating a
 * number or silently omitting the target altogether.
 */

export type SloUnit = "rate" | "ms";

export interface SloDefinition {
  id: string;
  description: string;
  target: number;
  unit: SloUnit;
  windowHours: number;
  rationale: string;
  /** Whether `scripts/slo-report.mts` can compute this from `generation_event`
   *  today, or only from OTel data this app doesn't query back. */
  computableFromGenerationEvent: boolean;
}

export const SLOS: readonly SloDefinition[] = [
  {
    id: "generation_success_rate",
    description: "Share of provider-attempted generations that complete successfully.",
    target: 0.97,
    unit: "rate",
    windowHours: 24,
    rationale:
      "Provider outages and mid-stream stalls happen at a real, low single-digit rate even when " +
      "this app's own code is correct; below 97% over a full day, the cause is more likely in this " +
      "stack than the provider's.",
    computableFromGenerationEvent: true,
  },
  {
    id: "generation_ttft_p95",
    description: "95th-percentile time to first token for a successful generation.",
    target: 3000,
    unit: "ms",
    windowHours: 1,
    rationale:
      "Streaming exists specifically to make the wait for the first token the number worth " +
      "protecting (ADR 0003) — 3s is a provisional ceiling pending real provider-latency data, not " +
      "a measured baseline (bench/BASELINE.md's own figures are against the mock provider).",
    computableFromGenerationEvent: true,
  },
  {
    id: "feed_read_p95",
    description: "95th-percentile latency of a shared-feed page read.",
    target: 500,
    unit: "ms",
    windowHours: 1,
    rationale:
      "An indexed Postgres read behind a short-TTL cache (docs/adr/0041, Plan 3) should be fast; a " +
      "regression here most likely means the cache or an index stopped doing its job.",
    computableFromGenerationEvent: false,
  },
  {
    id: "availability",
    description: "Share of /api/health checks reporting status \"ok\" (not degraded).",
    target: 0.995,
    unit: "rate",
    windowHours: 24,
    rationale:
      "A single-region, single-instance-class portfolio deployment, not a claimed multi-9s SLA — " +
      "this is a floor worth alerting under, not a promise made to anyone.",
    computableFromGenerationEvent: false,
  },
];

export interface SloAttainment {
  id: string;
  /** `undefined` means no data fell in the window — a real, distinct state
   *  from "met" or "not met", not the same as failing the target. */
  met: boolean | undefined;
  observed: number | undefined;
  target: number;
  unit: SloUnit;
}

/** `undefined` for an empty array — there is no 95th percentile of nothing,
 *  and pretending otherwise (e.g. returning 0) would silently misreport an
 *  empty window as a perfect one. Linear interpolation between the two
 *  nearest ranks, the common definition; exact tie-breaking at small sample
 *  sizes is not a concern this report needs to be precise about. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  if (p <= 0) return Math.min(...values);
  if (p >= 1) return Math.max(...values);

  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

/** `undefined` when the denominator is 0 — "no attempts in the window" is
 *  not the same fact as "0% success," and reporting it as 0 would read as a
 *  total outage that never happened. */
export function rate(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return numerator / denominator;
}

export function attainmentFromRate(def: SloDefinition, observed: number | undefined): SloAttainment {
  return {
    id: def.id,
    observed,
    target: def.target,
    unit: def.unit,
    met: observed === undefined ? undefined : observed >= def.target,
  };
}

/** Lower-is-better (latency) — the opposite comparison from a rate SLO. */
export function attainmentFromLatency(def: SloDefinition, observed: number | undefined): SloAttainment {
  return {
    id: def.id,
    observed,
    target: def.target,
    unit: def.unit,
    met: observed === undefined ? undefined : observed <= def.target,
  };
}

export interface GenerationOutcomeCounts {
  success: number;
  persistFailed: number;
  providerError: number;
  /** Excluded from both numerator and denominator — a client disconnect is
   *  the Writer leaving, not this app or the provider failing them (the same
   *  reasoning route.ts already applies to not billing a cancelled turn). */
  cancelled: number;
}

export function generationSuccessRateAttainment(counts: GenerationOutcomeCounts): SloAttainment {
  const def = SLOS.find((s) => s.id === "generation_success_rate")!;
  const numerator = counts.success + counts.persistFailed;
  const denominator = numerator + counts.providerError;
  return attainmentFromRate(def, rate(numerator, denominator));
}

export function generationTtftAttainment(successfulTtftMs: readonly number[]): SloAttainment {
  const def = SLOS.find((s) => s.id === "generation_ttft_p95")!;
  return attainmentFromLatency(def, percentile(successfulTtftMs, 0.95));
}
