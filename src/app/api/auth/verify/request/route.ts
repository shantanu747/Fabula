import { auth } from "@/auth";
import { guardVerifyRequest } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { createVerificationToken } from "@/lib/auth/verificationTokens";
import { getMailer } from "@/lib/email/registry";
import { verificationEmail } from "@/lib/email/templates";
import { log, LOG_EVENTS } from "@/lib/observability/logger";

/**
 * Requests (or re-requests) a verification email for the signed-in Writer's
 * own address — no email in the body, unlike /password/request, because
 * there's no enumeration question here: the caller already proved they
 * control this account by being signed into it (docs/adr/0046).
 */
export async function POST(request: Request) {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const limited = await guardVerifyRequest(session.user.id);
  if (limited) return limited;

  // Already verified — a no-op, not an error: a stale tab that never learned
  // its own state can safely call this and get the same success response.
  if (!session.user.verified) {
    const token = await createVerificationToken(session.user.email);
    const link = `${new URL(request.url).origin}/api/auth/verify/${token}`;
    await getMailer()
      .send({ to: session.user.email, ...verificationEmail(link) })
      .catch((err) => log.error(LOG_EVENTS.PERSIST_FAILED, { reason: "verification_email", err }));
  }

  return Response.json({ ok: true });
}
