import type { Session } from "next-auth";

/**
 * The session the mocked `auth()` returns. Held in its own module so the mock
 * factory and the specs that drive it reference the same binding.
 *
 * `auth` is a destructured NextAuth export used at nine call sites with no
 * injection point, so a module mock is the only available seam — see
 * docs/adr/0014. It is the only module mock in the suite; everything else is
 * injected (the db via __setDbForTests, providers via the registry).
 */
let current: Session | null = null;

export function setTestSession(session: Session | null): void {
  current = session;
}

export function getTestSession(): Session | null {
  return current;
}

/** Builds the minimal session shape the route handlers actually read. */
export function sessionForUser(userId: string): Session {
  return {
    user: { id: userId },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  } as Session;
}
