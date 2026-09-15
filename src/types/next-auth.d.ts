import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** Stamped into the JWT at sign-in, compared against the live value on
       *  every mutating route (docs/adr/0047). Not itself sensitive — it's an
       *  integer, never a secret — but only ever read server-side. */
      tokenVersion: number;
      /** Refreshed only on an explicit `update()` call (docs/adr/0046) — see
       *  src/auth.ts's jwt callback. Drives the UI's share gate; the
       *  authoritative check still re-reads the database at share time.
       *  Named distinctly from `emailVerified` (kept, elsewhere, as the raw
       *  `Date | null` Auth.js/the adapter expect) — reusing that name for
       *  this boolean collides with @auth/core's own conditional typing of
       *  `AdapterUser.emailVerified` and doesn't type-check. */
      verified: boolean;
    } & DefaultSession["user"];
  }

  // `User.emailVerified` structurally satisfies property access on
  // `Session.user` too (TypeScript doesn't distinguish which augmented
  // interface a property access resolves through), so `session.user.emailVerified`
  // silently type-checks as `Date | null | undefined` instead of erroring —
  // it is never actually populated there. Always use `session.user.verified`
  // (above) on a Session; this field is only for the `user` callback
  // parameter (authorize()'s return value, or the adapter's row).
  interface User {
    tokenVersion?: number;
    emailVerified?: Date | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    tokenVersion?: number;
    verified?: boolean;
  }
}
