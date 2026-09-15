import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { guardLogin } from "@/lib/ratelimit/guard";
import { hashIdentity } from "@/lib/ratelimit/policy";
import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { TooManyAttemptsError } from "./errors";

/**
 * Paid on every login attempt for an address with no account, so
 * `bcrypt.compare`'s cost — the dominant term in this handler's latency — is
 * spent on both branches and timing can't distinguish "no such account" from
 * "wrong password" (the same posture ADR 0011 established for registration).
 * Lazily hashed once per process, mirroring this codebase's other lazy
 * constructions, rather than a hardcoded literal hash.
 */
let dummyPasswordHash: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) {
    dummyPasswordHash = bcrypt.hash("no-account-exists-for-this-address", 12);
  }
  return dummyPasswordHash;
}

/** Test-only seam — a fresh process-lifetime memo would otherwise make one
 *  test's hash computation bleed into another's mock expectations. */
export function __resetDummyPasswordHashForTests(): void {
  dummyPasswordHash = undefined;
}

export interface AuthorizedUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  tokenVersion: number;
  emailVerified: Date | null;
}

/**
 * The Credentials provider's `authorize`, extracted so it's testable without
 * driving the whole NextAuth callback pipeline (docs/adr/0046) — `auth.ts`
 * itself is otherwise untestable at nine call sites with no injection point
 * (see src/test/session.ts's own note on this).
 */
export async function authorizeCredentials(
  credentials: Record<string, unknown> | undefined,
  request: Request
): Promise<AuthorizedUser | null> {
  const email = credentials?.email;
  const password = credentials?.password;
  if (typeof email !== "string" || typeof password !== "string") return null;
  const identityHash = hashIdentity(email);

  // Before the bcrypt compare, which is the expensive part of this handler
  // and therefore the part worth protecting from being invoked in a loop
  // (same reasoning as guardRegister).
  const limited = await guardLogin(request, email);
  if (limited) {
    log.warn(LOG_EVENTS.LOGIN_FAILED, { reason: "rate_limited", identityHash });
    throw new TooManyAttemptsError();
  }

  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  // Always compared, whether or not `user` exists — see getDummyPasswordHash.
  const valid = await bcrypt.compare(password, user?.passwordHash ?? (await getDummyPasswordHash()));

  if (!user?.passwordHash || !valid) {
    log.warn(LOG_EVENTS.LOGIN_FAILED, { reason: "invalid_credentials", identityHash });
    return null;
  }

  log.info(LOG_EVENTS.LOGIN_SUCCEEDED, { identityHash });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    tokenVersion: user.tokenVersion,
    emailVerified: user.emailVerified,
  };
}
