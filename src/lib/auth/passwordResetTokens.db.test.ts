import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { passwordResetTokens, users } from "@/lib/db/schema";
import { createPasswordResetToken, verifyAndConsumePasswordResetToken } from "./passwordResetTokens";

async function createUser() {
  const [user] = await getDb().insert(users).values({ email: `writer-${crypto.randomUUID()}@example.com` }).returning();
  return user;
}

describe("createPasswordResetToken / verifyAndConsumePasswordResetToken", () => {
  it("round-trips: the raw token verifies and returns the user it was issued for", async () => {
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);

    const result = await verifyAndConsumePasswordResetToken(token);
    expect(result).toEqual({ userId: user.id });
  });

  it("never stores the raw token — only its hash is on file", async () => {
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);

    const rows = await getDb().select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it("is single-use: a second consumption of the same token fails", async () => {
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);

    expect(await verifyAndConsumePasswordResetToken(token)).toEqual({ userId: user.id });
    expect(await verifyAndConsumePasswordResetToken(token)).toBeNull();
  });

  it("rejects a token that was never issued", async () => {
    expect(await verifyAndConsumePasswordResetToken("not-a-real-token")).toBeNull();
  });

  it("requesting a new reset invalidates the user's previous token", async () => {
    const user = await createUser();
    const first = await createPasswordResetToken(user.id);
    const second = await createPasswordResetToken(user.id);

    expect(await verifyAndConsumePasswordResetToken(first)).toBeNull();
    expect(await verifyAndConsumePasswordResetToken(second)).toEqual({ userId: user.id });
  });

  it("rejects an expired token", async () => {
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);

    await getDb()
      .update(passwordResetTokens)
      .set({ expires: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.userId, user.id));

    expect(await verifyAndConsumePasswordResetToken(token)).toBeNull();
  });

  it("two concurrent consumptions of the same token: exactly one succeeds", async () => {
    // The atomicity property the single UPDATE...WHERE...RETURNING statement
    // exists for (docs/adr/0046) — a SELECT-then-UPDATE across two statements
    // would let both callers observe "not yet used" and both succeed.
    const user = await createUser();
    const token = await createPasswordResetToken(user.id);

    const [first, second] = await Promise.all([
      verifyAndConsumePasswordResetToken(token),
      verifyAndConsumePasswordResetToken(token),
    ]);

    const successes = [first, second].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });
});
