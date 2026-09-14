import { randomBytes, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { verificationTokens } from "@/lib/db/schema";

const TOKEN_BYTES = 32;
const EXPIRY_MS = 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Creates a fresh verification token for an address, storing only its hash
 * (docs/adr/0046 — a leaked database of live tokens must not itself be a
 * usable set of verification links). Any tokens already on file for this
 * address are cleared first: the composite (identifier, token) primary key
 * would otherwise let a Writer who requests a resend accumulate an
 * unbounded number of still-valid tokens for the same address.
 *
 * Returns the raw token — the only place it exists outside the Writer's
 * inbox, since only its hash is ever persisted.
 */
export async function createVerificationToken(email: string): Promise<string> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const db = getDb();
  await db.delete(verificationTokens).where(eq(verificationTokens.identifier, email));
  await db.insert(verificationTokens).values({
    identifier: email,
    token: hashToken(rawToken),
    expires: new Date(Date.now() + EXPIRY_MS),
  });
  return rawToken;
}

/**
 * Single-use: the matching row is deleted whether or not it was still valid,
 * so a replayed link (even one that arrives via a lookup racing this same
 * function) can never succeed twice. Looked up by the token's hash alone —
 * not by (identifier, token) together, so the link itself needs no email in
 * it — and matched via a plain DB index-equality lookup rather than an
 * application-level string comparison, which is the meaningful distinction
 * from `CRON_SECRET`'s `timingSafeEqual` guard (docs/adr/0048): there is no
 * early-exit character-by-character compare here for a timing side channel
 * to ride on, only a found-or-not-found index probe against an
 * unguessable 256-bit value.
 */
export async function verifyToken(rawToken: string): Promise<{ email: string } | null> {
  const tokenHash = hashToken(rawToken);
  const db = getDb();
  const [row] = await db.select().from(verificationTokens).where(eq(verificationTokens.token, tokenHash));
  if (!row) return null;

  await db
    .delete(verificationTokens)
    .where(and(eq(verificationTokens.identifier, row.identifier), eq(verificationTokens.token, tokenHash)));

  if (row.expires.getTime() < Date.now()) return null;
  return { email: row.identifier };
}
