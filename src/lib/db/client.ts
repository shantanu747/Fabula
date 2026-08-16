import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import type { AppDatabase } from "./types";

// Constructed lazily, not at module scope — the Neon driver throws immediately if
// DATABASE_URL isn't set, which would otherwise break `next build`/`next dev` startup
// before a developer has provisioned a database (mirrors the lazy provider-client
// pattern in src/lib/providers/anthropic.ts's getClient()).
let db: AppDatabase | undefined;

function createDb() {
  return drizzle({ client: neon(process.env.DATABASE_URL!), schema });
}

export function getDb(): AppDatabase {
  if (!db) db = createDb();
  return db;
}

/**
 * @auth/drizzle-adapter's SqlFlavorOptions requires a full PgDatabase, which
 * AppDatabase is not (it lacks `transaction`). Only src/auth.ts may use this.
 */
export function getAuthAdapterDb() {
  return createDb();
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
