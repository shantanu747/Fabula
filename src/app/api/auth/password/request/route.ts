import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { guardPasswordResetRequest } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { readJsonBody } from "@/lib/http/readJsonBody";
import { createPasswordResetToken } from "@/lib/auth/passwordResetTokens";
import { getMailer } from "@/lib/email/registry";
import { passwordResetEmail } from "@/lib/email/templates";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { hashIdentity } from "@/lib/ratelimit/policy";
import { withRoute } from "@/lib/observability/withRoute";

interface RequestBody {
  email: string;
}

function isValidBody(body: unknown): body is RequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.email === "string" && b.email.length <= 320;
}

const UNINFORMATIVE_RESPONSE = { ok: true, message: "If that address has an account, we've sent a reset link." };

/**
 * Always the same response whether or not the address exists, or exists but
 * has no password (a Google-only account) — the same uninformative-response
 * posture ADR 0011 established for registration, extended here (docs/adr/0046).
 */
export const POST = withRoute("/api/auth/password/request", async (request: Request) => {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  if (!isValidBody(parsed.body)) {
    return Response.json({ error: "A valid email is required." }, { status: 400 });
  }
  const { email } = parsed.body;

  const limited = await guardPasswordResetRequest(request, email);
  if (limited) return limited;

  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  if (user?.passwordHash) {
    const token = await createPasswordResetToken(user.id);
    const link = `${new URL(request.url).origin}/reset?token=${token}`;
    await getMailer()
      .send({ to: email, ...passwordResetEmail(link) })
      .catch((err) => log.error(LOG_EVENTS.PERSIST_FAILED, { reason: "password_reset_email", err }));
    log.info(LOG_EVENTS.PASSWORD_RESET_REQUESTED, { identityHash: hashIdentity(email) });
  }

  return Response.json(UNINFORMATIVE_RESPONSE);
});
