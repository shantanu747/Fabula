import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { TEST_DB_BASE_URL } from "@/test/db-names";

/**
 * Migration 0005's backfill, proved against data written *before* the
 * migration ran — every other db.test.ts clones a database built from the
 * fully-migrated template (setup-db.ts), which is the wrong shape for this:
 * it never has a story that predates `paragraphCount`/`contentHash`. This
 * file builds its own database instead, applying migrations 0000-0004,
 * inserting data the old way, then applying 0005 and checking what it did
 * (docs/adr/0041).
 *
 * Migrations are applied by reading each .sql file directly and running its
 * statements — the same "--> statement-breakpoint" splitting drizzle-kit's
 * own migrator uses — rather than depending on drizzle's journal/bookkeeping
 * machinery, which this test has no need for (nothing here re-runs a
 * migration or checks resumability, only what one specific file does to
 * pre-existing rows).
 */

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const PRE_BACKFILL_MIGRATIONS = [
  "0000_fluffy_alice.sql",
  "0001_add_hot_path_indexes.sql",
  "0002_add_rate_limit_buckets.sql",
  "0003_minor_oracle.sql",
  "0004_remarkable_mongoose.sql",
];
const BACKFILL_MIGRATION = "0005_denormalized_counters_and_cache_columns.sql";

const DB_NAME = `fabula_test_migration_${process.env.VITEST_POOL_ID ?? "1"}`;

async function applyMigrationFile(pool: Pool, filename: string) {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
}

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();

  pool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${DB_NAME}` });
  for (const migration of PRE_BACKFILL_MIGRATIONS) {
    await applyMigrationFile(pool, migration);
  }
});

afterAll(async () => {
  await pool?.end();
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  await admin.end();
});

describe("migration 0005 — paragraphCount/contentHash backfill", () => {
  it("backfills paragraphCount to the real count, and leaves contentHash null", async () => {
    // Pre-existing rows, written the way the app wrote them before this
    // migration's columns existed — no paragraphCount, no contentHash.
    await pool.query(`INSERT INTO "user" ("id", "email") VALUES ('u1', 'w1@example.com')`);
    await pool.query(`
      INSERT INTO "story" ("id", "ownerId", "targetLength", "selectedProviderId")
      VALUES
        ('story-with-3', 'u1', 10, 'anthropic'),
        ('story-with-0', 'u1', 10, 'anthropic'),
        ('story-with-1', 'u1', 10, 'anthropic')
    `);
    await pool.query(`
      INSERT INTO "story_paragraph" ("id", "storyId", "authorType", "text", "position")
      VALUES
        ('p1', 'story-with-3', 'writer', 'one', 0),
        ('p2', 'story-with-3', 'ai', 'two', 1),
        ('p3', 'story-with-3', 'writer', 'three', 2),
        ('p4', 'story-with-1', 'writer', 'only one', 0)
    `);

    await applyMigrationFile(pool, BACKFILL_MIGRATION);

    const { rows } = await pool.query<{ id: string; paragraphCount: number; contentHash: string | null }>(
      `SELECT "id", "paragraphCount", "contentHash" FROM "story" ORDER BY "id"`
    );

    expect(rows).toEqual([
      { id: "story-with-0", paragraphCount: 0, contentHash: null },
      { id: "story-with-1", paragraphCount: 1, contentHash: null },
      { id: "story-with-3", paragraphCount: 3, contentHash: null },
    ]);
  });

  it("adds the new generation_event columns and indexes without error", async () => {
    // Guards the migration itself, not application code — the same category
    // of regression ADR 0017 found once (a migration present in schema.ts but
    // never actually applied). Asserts structure, not behavior: paragraphs.ts
    // and queries.perf.test.ts already prove the columns/indexes do the right
    // thing once populated.
    const { rows: columns } = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'generation_event'
        AND column_name IN ('cacheReadInputTokens', 'cacheCreationInputTokens')
    `);
    expect(columns.map((r) => r.column_name).sort()).toEqual([
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
    ]);

    const { rows: indexes } = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'generation_event'
    `);
    expect(indexes.map((r) => r.indexname)).toContain("generation_event_storyId_index");
  });
});
