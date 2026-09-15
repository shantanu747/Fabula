import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { verifyToken } from "@/lib/auth/verificationTokens";
import { log, LOG_EVENTS } from "@/lib/observability/logger";

/**
 * The link a Writer clicks from their inbox — necessarily a plain GET (an
 * email client can't send a POST), and the single-use, unguessable token is
 * itself the authorization, so this needs no Origin check or session (a
 * Writer may well click it from a different browser than the one they
 * registered in). No rate limit either, for the same reason CRON_SECRET
 * needs none beyond a constant-time compare: guessing a 256-bit token isn't
 * a realistic target regardless of attempt count (docs/adr/0048).
 */
export async function GET(request: Request, { params }: RouteContext<"/api/auth/verify/[token]">) {
  const { token } = await params;

  const result = await verifyToken(token);
  if (!result) {
    return Response.redirect(new URL("/verify?status=invalid", request.url));
  }

  const [user] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, result.email));
  if (user) {
    await getDb().update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    log.info(LOG_EVENTS.EMAIL_VERIFIED, {});
  }

  return Response.redirect(new URL("/verify?status=success", request.url));
}
