/**
 * Prints attainment against the operational targets in
 * `src/lib/observability/slo.ts`, queried from `generation_event` — the
 * first thing in this repo to ever read that table back (docs/adr/0022,
 * docs/adr/0049). Run via `npm run slo-report`; needs `DATABASE_URL`.
 *
 * Only two of the four defined SLOs are computable from this table today
 * (`generationSuccessRateAttainment`/TTFT p95) — feed-read p95 and
 * availability live only in OTel metrics this app doesn't query back (see
 * `slo.ts`'s own doc comment for why). Both are still printed, explicitly
 * marked "not computable from generation_event," rather than silently
 * dropped — an SLO with no attainment line reads as forgotten, not as
 * "measured elsewhere."
 */
import {
  fetchRecentGenerationOutcomes,
  type RecentGenerationOutcome,
} from "../src/lib/db/generationEvents";
import { getDb, hasDatabase } from "../src/lib/db/client";
import {
  SLOS,
  generationSuccessRateAttainment,
  generationTtftAttainment,
  type SloAttainment,
  type SloDefinition,
} from "../src/lib/observability/slo";

export function countOutcomes(rows: readonly RecentGenerationOutcome[]) {
  let success = 0;
  let persistFailed = 0;
  let providerError = 0;
  let cancelled = 0;
  for (const row of rows) {
    if (row.outcome === "success") success++;
    else if (row.outcome === "persist_failed") persistFailed++;
    else if (row.outcome === "provider_error") providerError++;
    else if (row.outcome === "cancelled") cancelled++;
  }
  return { success, persistFailed, providerError, cancelled };
}

export function successfulTtftMs(rows: readonly RecentGenerationOutcome[]): number[] {
  return rows
    .filter((r) => (r.outcome === "success" || r.outcome === "persist_failed") && r.ttftMs !== null)
    .map((r) => r.ttftMs as number);
}

function formatAttainment(def: SloDefinition, attainment: SloAttainment): string {
  const unitSuffix = attainment.unit === "rate" ? "%" : "ms";
  const format = (v: number) => (attainment.unit === "rate" ? (v * 100).toFixed(2) : v.toFixed(0));
  const target = `target ${format(def.target)}${unitSuffix} over ${def.windowHours}h`;

  if (attainment.observed === undefined) {
    return `[NO DATA] ${def.id} — no events in the window (${target})`;
  }
  const status = attainment.met ? "MET" : "MISSED";
  return `[${status}]    ${def.id} — observed ${format(attainment.observed)}${unitSuffix} (${target})`;
}

export async function buildReport(now: Date = new Date()): Promise<string> {
  const lines: string[] = [];

  if (!hasDatabase()) {
    return "slo-report: no DATABASE_URL configured — nothing to report against.";
  }
  const db = getDb();

  for (const def of SLOS) {
    if (!def.computableFromGenerationEvent) {
      lines.push(
        `[N/A]      ${def.id} — not computable from generation_event; needs OTel metric data ` +
          `(target ${def.unit === "rate" ? `${(def.target * 100).toFixed(2)}%` : `${def.target}ms`} over ${def.windowHours}h)`
      );
      continue;
    }

    const since = new Date(now.getTime() - def.windowHours * 60 * 60 * 1000);
    const rows = await fetchRecentGenerationOutcomes(db, since);

    const attainment =
      def.id === "generation_success_rate"
        ? generationSuccessRateAttainment(countOutcomes(rows))
        : generationTtftAttainment(successfulTtftMs(rows));

    lines.push(formatAttainment(def, attainment));
    lines.push(`           ${def.rationale}`);
  }

  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  buildReport().then((report) => console.log(report));
}
