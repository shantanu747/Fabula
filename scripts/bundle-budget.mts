/**
 * Checks each budgeted route's first-load JS (gzipped) against budgets.json.
 * Run after `next build` — see `npm run bundle-budget` and docs/adr/0024.
 *
 * Next 16 builds with Turbopack by default, which does not produce the
 * webpack-era `.next/app-build-manifest.json`. The per-route entry chunks
 * instead live in `.next/server/app/<route>/page_client-reference-manifest.js`
 * — a JS file (`globalThis.__RSC_MANIFEST[...] = {...}`), not JSON — under its
 * `entryJSFiles` map. That shape is not a stable public API, so every read
 * below fails with a specific, actionable message rather than a bare
 * TypeError if a Next upgrade changes it.
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

export interface RouteSize {
  route: string;
  chunks: string[];
  gzippedBytes: number;
}

export interface BudgetRow {
  route: string;
  measured: number;
  budget: number;
  deltaBytes: number;
  deltaPercent: number;
  over: boolean;
}

/** `/` -> "page", `/story` -> "story/page", `/feed/[id]` -> "feed/[id]/page". */
function routeToSegment(route: string): string {
  const trimmed = route === "/" ? "" : route.replace(/^\//, "");
  return trimmed ? `${trimmed}/page` : "page";
}

function routeToEntryKey(route: string): string {
  const trimmed = route === "/" ? "" : route.replace(/^\//, "");
  return trimmed ? `[project]/src/app/${trimmed}/page` : "[project]/src/app/page";
}

/**
 * Extracts the object literal assigned to `globalThis.__RSC_MANIFEST[...]` in
 * a `*_client-reference-manifest.js` file's source text. Scans braces rather
 * than regex-matching to the last `}`, since the object can itself contain
 * `{`/`}` inside string values (chunk paths never do today, but nothing
 * guarantees that).
 */
export function extractClientReferenceManifest(source: string, route: string): unknown {
  const marker = "__RSC_MANIFEST[";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      `bundle-budget: build manifest shape changed — update scripts/bundle-budget.mts ` +
        `(route ${route}: no "${marker}" assignment found in the client-reference-manifest)`
    );
  }
  const braceStart = source.indexOf("{", source.indexOf("=", markerIndex));
  if (braceStart === -1) {
    throw new Error(
      `bundle-budget: build manifest shape changed — update scripts/bundle-budget.mts ` +
        `(route ${route}: no "{" following the __RSC_MANIFEST assignment)`
    );
  }

  let depth = 0;
  let inString = false;
  let quote = "";
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped character
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(
      `bundle-budget: build manifest shape changed — update scripts/bundle-budget.mts ` +
        `(route ${route}: unbalanced braces while scanning the __RSC_MANIFEST object)`
    );
  }

  try {
    return JSON.parse(source.slice(braceStart, end));
  } catch (cause) {
    throw new Error(
      `bundle-budget: build manifest shape changed — update scripts/bundle-budget.mts ` +
        `(route ${route}: the extracted __RSC_MANIFEST object is not valid JSON)`,
      { cause }
    );
  }
}

/** Reads one route's client-reference-manifest.js and returns its entry chunk list. */
export function readEntryChunks(nextDir: string, route: string): string[] {
  const manifestPath = join(nextDir, "server", "app", `${routeToSegment(route)}_client-reference-manifest.js`);
  let source: string;
  try {
    source = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw new Error(
      `bundle-budget: expected ${manifestPath} for route ${route} — run \`next build\` first, ` +
        `or update scripts/bundle-budget.mts if Next moved this file`,
      { cause }
    );
  }

  const manifest = extractClientReferenceManifest(source, route);
  const entryJSFiles = (manifest as { entryJSFiles?: Record<string, unknown> }).entryJSFiles;
  if (!entryJSFiles || typeof entryJSFiles !== "object") {
    throw new Error(
      `bundle-budget: build manifest shape changed — update scripts/bundle-budget.mts ` +
        `(route ${route}: no "entryJSFiles" object in the manifest)`
    );
  }

  const key = routeToEntryKey(route);
  const chunks = entryJSFiles[key];
  if (!Array.isArray(chunks) || !chunks.every((c) => typeof c === "string")) {
    throw new Error(
      `bundle-budget: build manifest shape changed — update scripts/bundle-budget.mts ` +
        `(route ${route}: expected entryJSFiles["${key}"] to be a string array, got ${JSON.stringify(chunks)})`
    );
  }
  return chunks;
}

/** Sums the gzipped on-disk size of a route's unique JS chunks. Raw bytes
 *  overstate what a user actually downloads. */
export function measureRoute(nextDir: string, route: string): RouteSize {
  const chunks = readEntryChunks(nextDir, route);
  let gzippedBytes = 0;
  for (const chunk of chunks) {
    const absolute = join(nextDir, chunk);
    const buffer = readFileSync(absolute);
    gzippedBytes += gzipSync(buffer).length;
  }
  return { route, chunks, gzippedBytes };
}

export function compareToBudgets(
  measured: Record<string, number>,
  budgets: Record<string, number>
): BudgetRow[] {
  return Object.entries(budgets).map(([route, budget]) => {
    const value = measured[route];
    if (value === undefined) {
      throw new Error(`bundle-budget: no measurement for budgeted route "${route}"`);
    }
    const deltaBytes = value - budget;
    return {
      route,
      measured: value,
      budget,
      deltaBytes,
      deltaPercent: (deltaBytes / budget) * 100,
      over: value > budget,
    };
  });
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export function formatReport(rows: BudgetRow[]): string {
  const header = ["Route", "Size", "Budget", "Delta", ""].map((h) => h.padEnd(10)).join("");
  const lines = rows.map((r) => {
    const delta = `${r.deltaBytes >= 0 ? "+" : ""}${formatKB(r.deltaBytes)} (${r.deltaPercent >= 0 ? "+" : ""}${r.deltaPercent.toFixed(1)}%)`;
    return [
      r.route.padEnd(10),
      formatKB(r.measured).padEnd(10),
      formatKB(r.budget).padEnd(10),
      delta.padEnd(20),
      r.over ? "OVER BUDGET" : "ok",
    ].join("");
  });
  return [header, ...lines].join("\n");
}

async function main(): Promise<void> {
  const repoRoot = join(import.meta.dirname, "..");
  const nextDir = join(repoRoot, ".next");
  const budgetsPath = join(repoRoot, "budgets.json");

  const { budgets } = JSON.parse(readFileSync(budgetsPath, "utf8")) as { budgets: Record<string, number> };

  const measured: Record<string, number> = {};
  for (const route of Object.keys(budgets)) {
    measured[route] = measureRoute(nextDir, route).gzippedBytes;
  }

  const rows = compareToBudgets(measured, budgets);
  console.log(formatReport(rows));

  const overBudget = rows.filter((r) => r.over);
  if (overBudget.length > 0) {
    console.error(
      `\n${overBudget.length} route(s) over budget: ${overBudget.map((r) => r.route).join(", ")}`
    );
    process.exit(1);
  }
}

// import.meta.dirname requires the file to actually be the entry point —
// guard so this file stays importable from the test suite without running main().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
