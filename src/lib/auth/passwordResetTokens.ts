import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { passwordResetTokens } from "@/lib/db/schema";

const TOKEN_BYTES = 32;
const EXPIRY_MS = 60 * 60 * 1000;

// CodeQL's js/insufficient-password-hash flags the line below: SHA-256 is
// indeed the wrong tool for a *password*, which has low, guessable entropy
// and needs a slow, salted KDF (bcrypt/scrypt/argon2) to resist
// brute-forcing. That query's heuristic fires here only because it traces
// the call back through createPasswordResetToken's name, not through what's
// actually being hashed — `rawToken` is `randomBytes(32)` (256 bits of real
// entropy, docs/adr/0046), never a user-chosen secret. A fast, unsalted hash
// is the textbook-correct choice for exactly this shape (Django, Rails, and
// Auth.js's own verification-token pattern all do the same): the value is
// unguessable regardless of hash speed, and a slow KDF would add nothing
// except being slower to look up on every request. See
// verifyAndConsumePasswordResetToken below for the actual security property
// this token relies on (single-use, time-limited, looked up by exact hash
// match).
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex"); // lgtm[js/insufficient-password-hash]
}

/**
 * Creates a fresh reset token for a user, storing only its hash (same
 * reasoning as verificationTokens.ts — docs/adr/0046). Existing tokens for
 * this user are cleared first, so requesting a new reset link invalidates
 * any earlier one still sitting in an old email.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const db = getDb();
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  await db.insert(passwordResetTokens).values({
    tokenHash: hashToken(rawToken),
    userId,
    expires: new Date(Date.now() + EXPIRY_MS),
  });
  return rawToken;
}

/**
 * Verifies and consumes a reset token in one statement — the same
 * read-modify-write-as-one-statement discipline the rest of this codebase
 * uses for anything with a single-use or capacity constraint (the rate
 * limiter's upsert, idempotent story creation): two concurrent requests
 * racing the same token must not both see it as valid, and a
 * SELECT-then-UPDATE across two statements is exactly the TOCTOU that
 * would allow. The conditional `UPDATE ... WHERE usedAt IS NULL AND expires
 * > now() RETURNING` either claims the token or returns no row; there is no
 * window where two callers can both observe "not yet used".
 */
export async function verifyAndConsumePasswordResetToken(rawToken: string): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(rawToken);
  const db = getDb();
  const [row] = await db
    .update(passwordResetTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expires, sql`now()`)
      )
    )
    .returning({ userId: passwordResetTokens.userId });

  return row ? { userId: row.userId } : null;
}
