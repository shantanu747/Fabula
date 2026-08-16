# 16. Asserted paragraph positions

## Status

Accepted. Amends the write mechanism in `docs/adr/0013-concurrency-safe-paragraph-positioning.md`; the decision recorded there, that the unique constraint is the primitive, is unchanged and is what this restores.

## Context

`docs/adr/0013` decided that `UNIQUE(storyId, position)` would be the thing that serialises concurrent turns, so that a request losing a race gets an observable `23505` instead of silently corrupting a story. The implementation then wrote Writer paragraphs with a statement of this shape:

```sql
insert into story_paragraph (...)
select v.id, ..., base.next + v.ord
  from (values ...) as v (...)
  cross join (
    select coalesce(max("position") + 1, 0) as next
      from story_paragraph where "storyId" = $1
  ) as base
```

Deriving the position inside the insert reads like the safer choice. It is the bug.

The race test written for `docs/adr/0014` is what surfaced it. Two requests reconcile against a story of two paragraphs; both pass the content-prefix check; the first appends at position 2 and commits; the second then runs its insert. Because that insert recomputes `max(position) + 1` at write time, it finds 3 rather than the 2 it validated against, collides with nothing, and appends its stale paragraph after the winner's.

The story ends up with two consecutive Writer paragraphs and a client whose positions no longer match the server's. This is precisely the interleaving `docs/adr/0013` set out to prevent, and it slipped through because nothing ever conflicted. The constraint was present, correct, and never consulted. The test failed with `{ ok: true, nextPosition: 4 }` where it expected a divergence, which is a good example of a passing constraint proving nothing on its own.

## Decision

Write the positions that were validated, and let the constraint reject anything else.

`appendParagraphsOnce` now takes a `basePosition` from the caller — the count of rows the reconciling read actually saw — and inserts at `basePosition + i` as bound parameters. The statement is a plain `INSERT ... VALUES` with no subquery.

The read and the write now refer to the same positions, so a request that lost the race collides on the unique index, raises `23505`, and is sent back around `syncStoryParagraphs`'s retry loop. The re-read then sees the winner's rows, the content-prefix check fails against them, and the caller gets a 409 rather than a silent interleave.

`nextPosition` is likewise derived from what the read validated rather than from anything the write returns, so the AI paragraph's slot is decided by the same reasoning that authorised the append.

## Consequences

- The unique constraint now does the job `docs/adr/0013` assigned it. The behaviour is covered by three concurrency specs, including a ten-way burst, and the one that failed before this change passes after it.
- A stale second tab now receives a 409 instead of quietly interleaving a paragraph. This is a slightly worse experience for a rare case, and the correct one: the alternative was corrupting a story invisibly.
- Positions are dense and gapless by construction, since they are assigned from a validated count rather than from a maximum that may have moved.
- The retry loop is bounded at three attempts and needs no backoff. A `23505` only surfaces after the conflicting transaction has committed, because the index insert blocks until then, so the next read is guaranteed to see the rows that caused it.
- The insert lost its subquery and is simpler and cheaper. What it gained is the property that it can fail.
- The general lesson is worth stating: re-deriving a value at write time destroys the conflict the constraint was there to detect. A constraint only enforces something if the write asserts what the read believed.
