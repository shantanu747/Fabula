import { beforeAll, describe, expect, it } from "vitest";
import { perfPool } from "@/test/setup-perf";

/**
 * Proves the indexes in migration 0001 are the ones the planner actually picks.
 *
 * Assertions are on plan shape, never on elapsed time. A wall-clock threshold
 * would be flaky on shared CI hardware and, worse, would pass happily while a
 * query silently reverted to a sequential scan — a seq scan over a small table
 * is fast, right up until the table is not small. The seed below is sized so
 * the planner has a real choice to make.
 */

const STORIES = 5_000;
const PARAGRAPHS_PER_STORY = 20;

/**
 * The data is deliberately skewed. With every key matching only a handful of
 * rows, Postgres reasonably picks a bitmap scan and sorts the result, and an
 * assertion about ordering would be testing the seed rather than the index. One
 * prolific Writer and one long story create the case where reading the index in
 * its own order is the plan that wins — which is the property the composite
 * column order was chosen for.
 */
const PROLIFIC_OWNER = "user-1";
const PROLIFIC_OWNER_STORIES = 1_000;
const LONG_STORY = "story-1";
const LONG_STORY_PARAGRAPHS = 500;

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

async function explain(sql: string, params: unknown[] = []): Promise<PlanNode> {
  const { rows } = await perfPool().query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    params
  );
  return rows[0]["QUERY PLAN"][0].Plan;
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function nodeTypes(plan: PlanNode): string[] {
  return flatten(plan).map((n) => n["Node Type"]);
}

function indexNames(plan: PlanNode): string[] {
  return flatten(plan)
    .map((n) => n["Index Name"])
    .filter((name): name is string => Boolean(name));
}

beforeAll(async () => {
  const pool = perfPool();

  // Seeded in SQL rather than through Drizzle: 100k paragraphs one INSERT at a
  // time would dominate the runtime of the suite.
  await pool.query(`
    INSERT INTO "user" ("id", "email")
    SELECT 'user-' || i, 'writer' || i || '@example.com'
      FROM generate_series(1, 20000) AS i
  `);

  await pool.query(`
    INSERT INTO "account" ("userId", "type", "provider", "providerAccountId")
    SELECT 'user-' || i, 'oauth', 'google', 'google-' || i
      FROM generate_series(1, 20000) AS i
  `);

  await pool.query(
    `
    INSERT INTO "story"
      ("id", "ownerId", "targetLength", "selectedProviderId", "isShared", "createdAt", "updatedAt")
    SELECT
      'story-' || i,
      CASE WHEN i <= $2 THEN $3 ELSE 'user-' || (2 + (i % 199)) END,
      10,
      'anthropic',
      (i % 20 = 0),
      now() at time zone 'utc',
      (now() at time zone 'utc') - (i || ' minutes')::interval
    FROM generate_series(1, $1::int) AS i
  `,
    [STORIES, PROLIFIC_OWNER_STORIES, PROLIFIC_OWNER]
  );

  await pool.query(
    `
    INSERT INTO "story_paragraph"
      ("id", "storyId", "authorType", "text", "position", "createdAt")
    SELECT
      'para-' || s || '-' || p,
      'story-' || s,
      CASE WHEN p % 2 = 0 THEN 'writer' ELSE 'ai' END,
      repeat('prose ', 20),
      p,
      now() at time zone 'utc'
    FROM generate_series(1, $1::int) AS s,
         generate_series(0, $2::int) AS p
  `,
    [STORIES, PARAGRAPHS_PER_STORY - 1]
  );

  await pool.query(
    `
    INSERT INTO "story_paragraph"
      ("id", "storyId", "authorType", "text", "position", "createdAt")
    SELECT
      'para-long-' || p,
      $1,
      CASE WHEN p % 2 = 0 THEN 'writer' ELSE 'ai' END,
      repeat('prose ', 20),
      p,
      now() at time zone 'utc'
    FROM generate_series($2::int, $3::int) AS p
  `,
    [LONG_STORY, PARAGRAPHS_PER_STORY, LONG_STORY_PARAGRAPHS - 1]
  );

  // Without fresh statistics the planner works from defaults and may pick a
  // sequential scan on a table it believes is tiny.
  await pool.query(`ANALYZE`);
});

describe("hot-path query plans", () => {
  it.each([
    ["a long story", LONG_STORY],
    ["a typical story", "story-4200"],
  ])("reads %s's paragraphs off the index rather than scanning the table", async (_label, storyId) => {
    // Every turn and every story render runs this. At 100k paragraphs a
    // sequential scan here is the difference between a page load and a timeout.
    //
    // Only the scan is asserted, not the absence of a Sort. This query has no
    // LIMIT — it wants the whole story — and for a full fetch Postgres often
    // prefers a bitmap scan (sequential heap access) plus an in-memory sort of a
    // few hundred rows over random index-order access. That is the right call.
    // The ordering-from-the-index property is what LIMIT queries need, and it is
    // asserted on the library list below, where it genuinely applies.
    const plan = await explain(
      `SELECT * FROM "story_paragraph" WHERE "storyId" = $1 ORDER BY "position" ASC`,
      [storyId]
    );

    expect(nodeTypes(plan)).not.toContain("Seq Scan");
    expect(indexNames(plan)).toContain("story_paragraph_storyId_position_unique");
  });

  it("lists a Writer's library newest-first without a sort step", async () => {
    // The composite index is (ownerId, updatedAt DESC): the equality predicate
    // first, the ordering second. Reversed, the planner would still use it for
    // the filter but would have to sort the result.
    //
    // The absence of a Sort node is the whole point, and it is fragile in a way
    // that is invisible from the schema: while the index was declared
    // "DESC NULLS LAST" (what Drizzle's .desc() emits) and this query asked for
    // a plain DESC (which means NULLS FIRST), the orderings did not match, the
    // index could not supply the sort, and the planner read every story the
    // Writer owned and sorted it — cost 128 against 5 for twenty rows.
    const plan = await explain(
      `SELECT * FROM "story" WHERE "ownerId" = $1 ORDER BY "updatedAt" DESC LIMIT 20`,
      [PROLIFIC_OWNER]
    );

    expect(nodeTypes(plan)).not.toContain("Seq Scan");
    expect(indexNames(plan)).toContain("story_ownerId_updatedAt_index");
    expect(nodeTypes(plan)).not.toContain("Sort");
  });

  it("reads the shared feed through the partial index", async () => {
    const plan = await explain(
      `SELECT * FROM "story" WHERE "isShared" = true ORDER BY "updatedAt" DESC LIMIT 20`
    );

    expect(indexNames(plan)).toContain("stories_updated_at_is_shared_idx");
    expect(nodeTypes(plan)).not.toContain("Seq Scan");
  });

  it("keeps the partial index small by excluding unshared stories", async () => {
    // The point of the partial index: it covers a twentieth of the table, so it
    // stays resident where a full index on updatedAt would not.
    const { rows } = await perfPool().query<{ partial: number; full: number }>(`
      SELECT
        pg_relation_size('"stories_updated_at_is_shared_idx"') AS partial,
        pg_relation_size('"story_ownerId_updatedAt_index"') AS full
    `);

    expect(Number(rows[0].partial)).toBeLessThan(Number(rows[0].full));
  });

  it("finds a user's linked accounts without scanning", async () => {
    // Postgres does not index foreign keys automatically, and this one is read
    // on every OAuth sign-in.
    const plan = await explain(`SELECT * FROM "account" WHERE "userId" = $1`, ["user-7"]);

    expect(nodeTypes(plan)).not.toContain("Seq Scan");
  });
});
