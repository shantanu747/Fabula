import type { AppDatabase } from "@/lib/db/types";

/**
 * Counts the driver-boundary calls the application actually makes, tagged by
 * call shape (which of Drizzle's four statement-issuing methods was invoked).
 * See docs/plans/v4/01-load-harness.md and docs/adr/0034: this observes the
 * boundary the app crosses rather than reading source or parsing Postgres
 * logs, following the Proxy technique src/test/latch.ts established for
 * ADR 0014's deterministic race tests.
 *
 * Every one of the app's six round trips for a saved-story turn (the rate-limit
 * upsert, the story select, syncStoryParagraphs' select+insert, the AI-paragraph
 * CTE, and the generation_event insert) issues through exactly one of these four
 * methods — see src/lib/ratelimit/store.ts, src/app/api/generate/route.ts, and
 * src/lib/db/paragraphs.ts.
 */
const COUNTED_METHODS = ["select", "insert", "update", "execute"] as const;
type CountedMethod = (typeof COUNTED_METHODS)[number];

export interface RoundtripCounts {
  select: number;
  insert: number;
  update: number;
  execute: number;
}

export interface RoundtripCounter {
  /** Wraps a real AppDatabase. Every counted call is forwarded unchanged —
   *  same arguments, same return value, same thrown errors. */
  wrap(db: AppDatabase): AppDatabase;
  counts: RoundtripCounts;
  reset(): void;
  total(): number;
}

function isCountedMethod(prop: string | symbol): prop is CountedMethod {
  return typeof prop === "string" && (COUNTED_METHODS as readonly string[]).includes(prop);
}

export function createRoundtripCounter(): RoundtripCounter {
  const counts: RoundtripCounts = { select: 0, insert: 0, update: 0, execute: 0 };

  function wrap(db: AppDatabase): AppDatabase {
    return new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (!isCountedMethod(prop) || typeof value !== "function") {
          return value;
        }
        // The count happens inside this wrapper, at call time — not in get()
        // above, which fires on mere property access (e.g. `db.select` handed
        // off without being invoked) and would otherwise over-count.
        return (...args: unknown[]) => {
          counts[prop] += 1;
          return value.apply(target, args);
        };
      },
    });
  }

  return {
    wrap,
    counts,
    reset() {
      for (const method of COUNTED_METHODS) counts[method] = 0;
    },
    total() {
      return counts.select + counts.insert + counts.update + counts.execute;
    },
  };
}

/**
 * Process-wide singleton. src/lib/db/client.ts's `getDb()` is itself a
 * process-wide singleton (one AppDatabase per Next.js server process) — the
 * dev-only `/api/__bench/roundtrips` route reads this counter from a different
 * request than the ones that incremented it, so both sides need the same
 * instance rather than one each.
 */
let singleton: RoundtripCounter | undefined;

export function getRoundtripCounter(): RoundtripCounter {
  if (!singleton) singleton = createRoundtripCounter();
  return singleton;
}
