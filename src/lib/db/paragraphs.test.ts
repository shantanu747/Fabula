import { describe, expect, it, vi } from "vitest";
import { isUniqueViolation, syncStoryParagraphs } from "./paragraphs";
import type { AppDatabase } from "./types";
import type { StoryParagraph } from "@/lib/providers/types";

/**
 * The error-shape and retry-exhaustion logic, which is about how the code reacts
 * to the database rather than about what the database does. The behaviour that
 * genuinely needs Postgres — the unique constraint, real 23505s, real races —
 * lives in paragraphs.db.test.ts.
 */

interface StoredRow {
  position: number;
  authorType: "writer" | "ai";
  text: string;
}

/** A test double for AppDatabase covering only what syncStoryParagraphs calls. */
function fakeDb(stored: StoredRow[], onExecute: () => Promise<unknown>): AppDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => stored,
        }),
      }),
    }),
    execute: onExecute,
  } as unknown as AppDatabase;
}

/** Mimics how Drizzle wraps driver errors: original on `.cause`. */
function drizzleWrapped(code: string, depth = 1): Error {
  let err: Error & { code?: string; cause?: unknown } = Object.assign(new Error("driver"), { code });
  for (let i = 0; i < depth; i++) {
    err = Object.assign(new Error("DrizzleQueryError"), { cause: err });
  }
  return err;
}

const CLIENT: StoryParagraph[] = [{ author: "writer", text: "The Writer's paragraph." }];

describe("isUniqueViolation", () => {
  it("matches a unique violation reported directly on the error", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  it("matches a unique violation Drizzle has wrapped", () => {
    // The reason a top-level `err.code` check is not enough: Drizzle rethrows
    // every driver error as DrizzleQueryError with the original on `.cause`, so
    // the naive check silently never matches and every conflict escapes as a 500.
    expect(isUniqueViolation(drizzleWrapped("23505"))).toBe(true);
  });

  it("matches through several layers of wrapping", () => {
    expect(isUniqueViolation(drizzleWrapped("23505", 4))).toBe(true);
  });

  it("gives up rather than following an unbounded cause chain", () => {
    // A self-referential or very deep chain must not hang the request.
    expect(isUniqueViolation(drizzleWrapped("23505", 9))).toBe(false);
  });

  it.each([
    ["a different SQLSTATE", drizzleWrapped("23503")],
    ["a plain error", new Error("boom")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "23505"],
  ])("does not match %s", (_label, err) => {
    expect(isUniqueViolation(err)).toBe(false);
  });
});

describe("syncStoryParagraphs — reaction to conflicts", () => {
  it("gives up after a bounded number of conflicts instead of looping forever", async () => {
    // A pathologically busy story must end in a 409 the client can act on,
    // rather than an unbounded retry loop holding a serverless invocation open.
    let attempts = 0;
    const db = fakeDb([], async () => {
      attempts++;
      throw drizzleWrapped("23505");
    });

    const result = await syncStoryParagraphs(db, "story-1", CLIENT);

    expect(result).toEqual({ ok: false, reason: "diverged" });
    expect(attempts).toBe(3);
  });

  it("rethrows errors that are not conflicts", async () => {
    // A connection failure is not a lost race, and must not be reported to the
    // Writer as "your story diverged".
    const db = fakeDb([], async () => {
      throw drizzleWrapped("08006");
    });

    await expect(syncStoryParagraphs(db, "story-1", CLIENT)).rejects.toThrow("DrizzleQueryError");
  });

  it("succeeds on a retry once the conflicting write has landed", async () => {
    // 23505 only surfaces after the conflicting transaction committed, so the
    // next read is guaranteed to see its rows — which is why there is no backoff.
    let attempts = 0;
    const db = fakeDb([], async () => {
      attempts++;
      if (attempts === 1) throw drizzleWrapped("23505");
      return { rows: [] };
    });

    const result = await syncStoryParagraphs(db, "story-1", CLIENT);

    // nextPosition comes from what the read validated, never from the write's
    // return value — that is what makes the position an assertion rather than a
    // guess (see appendParagraphsOnce).
    expect(result).toEqual({ ok: true, storedBefore: 0, appended: 1, nextPosition: 1 });
    expect(attempts).toBe(2);
  });

  it("refuses to append when the client contradicts what is stored", async () => {
    const execute = vi.fn();
    const db = fakeDb([{ position: 0, authorType: "writer", text: "what the server has" }], execute);

    const result = await syncStoryParagraphs(db, "story-1", [
      { author: "writer", text: "what the client claims" },
    ]);

    expect(result).toEqual({ ok: false, reason: "diverged" });
    expect(execute).not.toHaveBeenCalled(); // nothing written on a divergence
  });
});
