import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { verificationTokens } from "@/lib/db/schema";
import { createVerificationToken, verifyToken } from "./verificationTokens";

describe("createVerificationToken / verifyToken", () => {
  it("round-trips: the raw token verifies and returns the address it was issued for", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const token = await createVerificationToken(email);

    const result = await verifyToken(token);
    expect(result).toEqual({ email });
  });

  it("never stores the raw token — only its hash is on file", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const token = await createVerificationToken(email);

    const rows = await getDb().select().from(verificationTokens).where(eq(verificationTokens.identifier, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].token).not.toBe(token);
  });

  it("is single-use: a second verification of the same token fails", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const token = await createVerificationToken(email);

    expect(await verifyToken(token)).toEqual({ email });
    expect(await verifyToken(token)).toBeNull();
  });

  it("rejects a token that was never issued", async () => {
    expect(await verifyToken("not-a-real-token")).toBeNull();
  });

  it("a fresh request invalidates the address's previous token", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const first = await createVerificationToken(email);
    const second = await createVerificationToken(email);

    expect(await verifyToken(first)).toBeNull();
    expect(await verifyToken(second)).toEqual({ email });
  });

  it("rejects an expired token", async () => {
    const email = `writer-${crypto.randomUUID()}@example.com`;
    const token = await createVerificationToken(email);

    // Back-date the row directly rather than waiting 24 hours or mocking
    // Date.now globally for a shared module-scope constant.
    await getDb()
      .update(verificationTokens)
      .set({ expires: new Date(Date.now() - 1000) })
      .where(eq(verificationTokens.identifier, email));

    expect(await verifyToken(token)).toBeNull();
  });
});
