import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import type { AppDatabase } from "./types";
import { getRoundtripCounter } from "../../../bench/roundtrips";

// Constructed lazily, not at module scope — the Neon driver throws immediately if
// DATABASE_URL isn't set, which would otherwise break `next build`/`next dev` startup
// before a developer has provisioned a database (mirrors the lazy provider-client
// pattern in src/lib/providers/anthropic.ts's getClient()).
let db: AppDatabase | undefined;

function createDb() {
  // Local-development escape hatch. The Neon driver speaks Neon's HTTP protocol,
  // not the Postgres wire protocol, so it cannot talk to a plain Postgres at all
  // — pointing DATABASE_URL at localhost fails with "fetch failed". Setting this
  // to a local Neon HTTP proxy lets a developer run the *production* driver
  // against a local database, which is the only way to catch behaviour that
  // differs between neon-http and the node-postgres driver the test suite uses
  // (see docs/adr/0014). Unset in production, where the endpoint is Neon's own.
  if (process.env.NEON_FETCH_ENDPOINT) {
    neonConfig.fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
  }
  return drizzle({ client: neon(process.env.DATABASE_URL!), schema });
}

export function getDb(): AppDatabase {
  if (!db) {
    const raw = createDb();
    // bench/harness.ts (docs/adr/0034) sets this on the app process it spawns,
    // never in a normal build or deployment — this is the only place that
    // branch can be taken. Wrapping here, once, at construction, is what lets
    // the counter see every call through the one shared `db` singleton,
    // regardless of which route makes it. Kept out of createDb() itself:
    // getAuthAdapterDb() below also calls createDb() and needs the full
    // NeonHttpDatabase type (transaction included) for the Auth.js adapter,
    // which the wrapped/narrowed AppDatabase type can't provide.
    db = process.env.BENCH_INSTRUMENTATION === "1" ? getRoundtripCounter().wrap(raw) : raw;
  }
  return db;
}

/**
 * Whether a database is available at all.
 *
 * Guest writing has never required one (docs/adr/0009), and rate limiting must
 * not quietly turn Postgres into a hard dependency of running the app at all —
 * a contributor cloning the repo to try the guest flow has no DATABASE_URL. This
 * reports the injected handle too, so the test suite counts as configured.
 */
export function hasDatabase(): boolean {
  return db !== undefined || Boolean(process.env.DATABASE_URL);
}

/**
 * @auth/drizzle-adapter's SqlFlavorOptions requires a full PgDatabase, which
 * AppDatabase is not (it lacks `transaction`) — that's why this keeps its own
 * return type distinct from getDb()'s, and why it can't just delegate to
 * getDb() itself. It doesn't need its own separate *instance* though: the
 * memo below (docs/adr/0041) means src/auth.ts's NextAuth factory reuses the
 * same underlying Drizzle handle getDb() does, instead of constructing (and
 * holding open) a second one for the lifetime of the process. Only src/auth.ts
 * may use this.
 */
let authAdapterDb: ReturnType<typeof createDb> | undefined;
export function getAuthAdapterDb() {
  if (!authAdapterDb) authAdapterDb = createDb();
  return authAdapterDb;
}

/**
 * Test-only seam. Guarded rather than conditionally compiled so misuse fails
 * loudly in production instead of silently swapping the driver.
 */
export function __setDbForTests(next: AppDatabase | undefined): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setDbForTests must never be called in production");
  }
  db = next;
}
