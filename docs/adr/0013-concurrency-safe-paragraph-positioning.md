# 13. Concurrency-safe paragraph positioning

## Status

Accepted. The write mechanism described below under "Atomic multi-row writes" is amended by
[0016](0016-asserted-paragraph-positions.md): deriving the position from `max(position) + 1`
inside the insert meant a request that lost a race never collided, so the constraint this
record relies on was never consulted. The decision recorded here is unchanged; 0016 is what
makes it hold.

## Context

The original `/api/generate` implementation suffered from a Time-of-Check-Time-of-Use (TOCTOU) race condition. When persisting a Writer's paragraphs followed by the AI's paragraph, the route would:

1. Read `SELECT position FROM story_paragraph WHERE storyId = $1` → `storedCount = rows.length`
2. Compute `input.storySoFar.slice(storedCount)` — a slice of a client-supplied array
3. Write bulk insert at `position: storedCount + i`
4. Write the AI paragraph at `position: input.storySoFar.length` — derived from the client array

Four independent auto-committing round trips created a window where concurrent requests both read `storedCount = 4`, both wrote positions 4 and 5, resulting in nondeterministic paragraph ordering when consumed with `ORDER BY position ASC`. The route also only compared lengths (`slice(storedCount)`), not content, so it didn't detect when the stored prefix differed from the client prefix.

## Decision

**Enforce position uniqueness with a database constraint**: Add a `UNIQUE(storyId, position)` constraint to `story_paragraph` table to prevent duplicate positions. This ensures that concurrent writes to the same position result in observable `23505 unique_violation` errors rather than silent corruption.

**Replace length-based reconciliation with content-based reconciliation**: Create `syncStoryParagraphs()` function that reads the stored paragraphs including their content, verifies the client array extends the stored content (not just length), and retries with fresh reads on conflicts.

**Atomic multi-row writes**: Use a single `INSERT ... SELECT ... VALUES ... CROSS JOIN (SELECT max(position) + 1 FROM ...)` statement for Writer paragraph batches. The `max(position)` subquery evaluates once as an InitPlan, making positions contiguous across the batch itself.

**Conditional AI paragraph write**: Use a data-modifying CTE with `ON CONFLICT DO NOTHING` for the AI paragraph, combining the insert with a story update in one atomic statement. If the position is already taken by a concurrent request, the operation gracefully returns `false` instead of failing.

**Robust error handling**: Wrap persistence calls in try/catch to prevent stream errors from causing client auto-retries that bill for already-successful generations.

The new flow:
1. `syncStoryParagraphs()` reconciles stored vs. client content, retries on conflicts
2. `appendParagraphsOnce()` inserts Writer paragraphs atomically at `max+1..max+n`
3. `insertAIParagraph()` inserts AI paragraph at `sync.nextPosition`, gracefully handling conflicts
4. Persistence errors no longer break the stream, preventing retry loops

## Consequences

- Concurrent requests can no longer interleave paragraphs incorrectly — the unique constraint enforces sequential positioning
- Client auto-retries are now idempotent — replayed requests detect they're redundant and append nothing
- Stale clients attempting to continue divergent stories receive 409 errors
- Round-trip count reduced from 5 to 4 (one SELECT eliminated by combining insert/update in CTE)
- Persistence errors no longer trigger client-side retries that cause double billing
- The read path maintains consistent performance through the unique index backing the constraint