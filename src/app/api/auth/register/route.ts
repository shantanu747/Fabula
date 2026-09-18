import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { guardRegister } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { readJsonBody } from "@/lib/http/readJsonBody";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { hashIdentity } from "@/lib/ratelimit/policy";
import { createVerificationToken } from "@/lib/auth/verificationTokens";
import { getMailer } from "@/lib/email/registry";
import { verificationEmail } from "@/lib/email/templates";
import { withRoute } from "@/lib/observability/withRoute";

const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320; // RFC 5321's own upper bound on a mailbox address
const MAX_PASSWORD_BYTES = 72; // bcrypt silently truncates past this — see below
const MIN_PASSWORD_LENGTH = 8;

interface RegisterBody {
  name: string;
  email: string;
  password: string;
}

function isValidBody(body: unknown): body is RegisterBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.name === "string" &&
    b.name.trim().length > 0 &&
    b.name.length <= MAX_NAME_LENGTH &&
    typeof b.email === "string" &&
    b.email.length <= MAX_EMAIL_LENGTH &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
    typeof b.password === "string" &&
    b.password.length >= MIN_PASSWORD_LENGTH
  );
}

/** bcryptjs silently truncates at 72 *bytes* (not characters) — past that, a
 *  128-character password is effectively its first 72 bytes, and two
 *  different long passwords can hash identically. Measuring
 *  `.length` alone would undercount multi-byte characters and let a
 *  password that's already over the real limit through. */
function passwordByteLength(password: string): number {
  return Buffer.byteLength(password, "utf8");
}

// The Credentials provider (src/auth.ts) has no built-in signup — this endpoint creates
// the user row it later authenticates against. The client calls signIn("credentials", …)
// immediately after a successful response here.
export const POST = withRoute("/api/auth/register", async (request: Request) => {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!isValidBody(body)) {
    log.warn(LOG_EVENTS.REGISTER_REJECTED, { reason: "invalid_body" });
    return Response.json(
      {
        error:
          "Name, a valid email, and a password of at least 8 characters are required.",
      },
      { status: 400 }
    );
  }

  if (passwordByteLength(body.password) > MAX_PASSWORD_BYTES) {
    log.warn(LOG_EVENTS.REGISTER_REJECTED, { reason: "password_too_long" });
    return Response.json({ error: "Password must be at most 72 bytes." }, { status: 400 });
  }

  // Before bcrypt, which is the expensive part of this handler and therefore the
  // part worth protecting from being invoked in a loop.
  const limited = await guardRegister(request);
  if (limited) {
    log.warn(LOG_EVENTS.REGISTER_REJECTED, { reason: "rate_limited", identityHash: hashIdentity(body.email) });
    return limited;
  }

  // Deliberately indistinguishable whether or not the email is already registered:
  // a "that account exists" response would let anyone probe which addresses have a
  // Fabula account. Hashing happens before the insert either way so the bcrypt cost
  // (the dominant term in this handler's latency) doesn't leak the answer by timing.
  const passwordHash = await bcrypt.hash(body.password, 12);

  // onConflictDoNothing rather than a select-then-insert: atomic against a concurrent
  // signup for the same address, and it can't clobber an existing account's password.
  // The client's follow-up signIn() is what actually decides whether the caller gets a
  // session, so a silent no-op here is safe.
  const [created] = await getDb()
    .insert(users)
    .values({ name: body.name, email: body.email, passwordHash })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  // Only a genuinely new account gets a verification email — a no-op insert
  // (the address already has an account) must not re-send anything, or this
  // endpoint's own uninformative-response posture would be undone by a
  // second email arriving only on the "already registered" branch.
  if (created) {
    const token = await createVerificationToken(body.email);
    const link = `${new URL(request.url).origin}/api/auth/verify/${token}`;
    await getMailer()
      .send({ to: body.email, ...verificationEmail(link) })
      .catch((err) => log.error(LOG_EVENTS.PERSIST_FAILED, { reason: "verification_email", err }));
  }

  return Response.json({ ok: true }, { status: 201 });
});
