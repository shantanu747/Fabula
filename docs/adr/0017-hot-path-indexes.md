# 17. Hot-path indexes and the NULLS ordering trap

## Status

Accepted.

## Context

The schema had no indexes beyond primary keys and the unique constraints. Postgres does not index foreign keys automatically, so `story_paragraph.storyId` — read on every turn and every story render — was unindexed, as were `story.ownerId` and `story_report.reporterId`. The library and feed queries both sort by `updatedAt` over a table with no index able to supply that order.

None of this is visible in development. A sequential scan over a few hundred rows is instant, and the query that will time out at scale looks identical to the one that will not.

## Decision

Add five indexes in migration `0001`, each backing a query on a request path:

| Index | Query |
|---|---|
| `account (userId)` | account lookup on every OAuth sign-in |
| `session (userId)` | session lookup |
| `story (ownerId, updatedAt DESC)` | `GET /api/stories`, the library list |
| `story (updatedAt) WHERE isShared` | `GET /api/feed` |
| `story_report (reporterId)` | report lookups |

The library index is composite in that order deliberately: `ownerId` is the equality predicate and `updatedAt` supplies the ordering, so one index read serves both and the `LIMIT` stops early. Reversed, the planner could still use it to filter but would have to sort the result.

The feed index is partial. Shared stories are a small fraction of the table, and a partial index stays small enough to keep resident. The perf suite asserts it is smaller than the full index next to it, so the claim is checked rather than asserted.

**Verify the plans, not the timings.** `src/lib/db/queries.perf.test.ts` seeds 5,000 stories, 100,000 paragraphs, and 20,000 accounts, runs `EXPLAIN (ANALYZE, FORMAT JSON)`, and asserts on the shape of the plan: which index was chosen, and whether a `Seq Scan` or a `Sort` node appears. Wall-clock thresholds were rejected because they are flaky on shared runners and, worse, because they pass happily while a query silently reverts to a sequential scan. A seq scan over a small table is fast right up until the table is not small, which is the failure this suite exists to catch.

The seed is deliberately skewed, with one prolific Writer and one long story. With every key matching only a handful of rows the planner reasonably prefers a bitmap scan and a sort, and an ordering assertion would be testing the seed rather than the index.

**Declare the ordered index without `NULLS LAST`.** This is the finding that justifies the suite existing.

Drizzle's `t.updatedAt.desc()` emits `DESC NULLS LAST` into the index definition. Drizzle's query-side `desc(stories.updatedAt)` emits a plain `desc`, which in Postgres means `NULLS FIRST`. The two orderings do not match, so the planner cannot take the sort from the index at all:

```
Limit  (cost=128.14..128.19 rows=20)
  ->  Sort  (cost=128.14..130.64 rows=1000)
        Sort Key: "updatedAt" DESC
        ->  Bitmap Heap Scan on story  (cost=32.03..101.53 rows=1000)
              ->  Bitmap Index Scan on "story_ownerId_updatedAt_index"
```

Every one of the Writer's stories is read and sorted to return twenty. Declaring the index as plain `DESC` so it matches what the ORM generates on the query side:

```
Limit  (cost=0.28..5.12 rows=20)
  ->  Index Scan using "story_ownerId_updatedAt_index" on story
```

Cost 128 to 5, and the difference grows with the number of stories a Writer owns. The column is `NOT NULL`, so nothing changes semantically; only whether the index can be used for ordering. The schema uses raw `sql` for that column because `.desc()` cannot express it.

## Consequences

- The index most likely to matter was, until this change, present and unusable for its purpose. It would have looked correct in review and in the schema, and it produced the plan above. This is the concrete argument for checking plans in CI rather than trusting that an index exists.
- The ordering match is fragile in a way the schema does not advertise. Anyone writing `.desc()` in an index definition reintroduces it, so both the schema and the migration carry a comment, and the perf suite asserts the absence of the `Sort` node.
- The paragraph query is asserted only to use its index, not to avoid a sort. It fetches a whole story with no `LIMIT`, and for a full fetch Postgres often prefers a bitmap scan plus an in-memory sort of a few hundred rows. That is the right call, and pinning it would be asserting a planner preference rather than a property.
- `npm run test:perf` needs a Postgres and takes seconds, so it sits outside `npm test`. Nothing enforces running it after an index change, which is a real gap left open in favour of keeping the default suite fast.
- Writing indexes with `drizzle-kit` surfaced a separate defect: the partial index's predicate was passed a bare column, which made `drizzle-kit generate` throw before writing anything. That is why migration `0001` was missing from `meta/_journal.json` and would never have been applied to a real database. The predicate is now `sql`, and the db suite builds its schema by running migrations so an unlisted one fails the build.
