import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { guardPasswordResetComplete } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { readJsonBody } from "@/lib/http/readJsonBody";
import { verifyAndConsumePasswordResetToken } from "@/lib/auth/passwordResetTokens";
import { bumpTokenVersion } from "@/lib/auth/tokenVersion";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { withRoute } from "@/lib/observability/withRoute";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;

interface ResetBody {
  token: string;
  password: string;
}

function isValidBody(body: unknown): body is ResetBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.token === "string" &&
    b.token.length > 0 &&
    typeof b.password === "string" &&
    b.password.length >= MIN_PASSWORD_LENGTH
  );
}

function passwordByteLength(password: string): number {
  return Buffer.byteLength(password, "utf8");
}

/**
 * Verifies the token, sets the new password, and bumps `tokenVersion` — the
 * one place in this codebase that invalidates every session issued before
 * this moment (docs/adr/0047). Unlike /password/request, a failure here is
 * informative: the token itself already proved the caller controls the
 * account, so "invalid or expired link" reveals nothing about whether an
 * address exists.
 */
export const POST = withRoute("/api/auth/password/reset", async (request: Request) => {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  const limited = await guardPasswordResetComplete(request);
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  if (!isValidBody(parsed.body)) {
    return Response.json({ error: "A token and a password of at least 8 characters are required." }, { status: 400 });
  }
  const { token, password } = parsed.body;

  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
    return Response.json({ error: "Password must be at most 72 bytes." }, { status: 400 });
  }

  const result = await verifyAndConsumePasswordResetToken(token);
  if (!result) {
    return Response.json({ error: "This reset link is invalid or has expired." }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await getDb().update(users).set({ passwordHash }).where(eq(users.id, result.userId));
  await bumpTokenVersion(result.userId);

  log.info(LOG_EVENTS.PASSWORD_RESET_COMPLETED, {});

  return Response.json({ ok: true });
});
