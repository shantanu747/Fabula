import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { getAuthAdapterDb, getDb } from "@/lib/db/client";
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema";
import { authorizeCredentials } from "@/lib/auth/authorize";
import { shouldAutoVerifyGoogleAccount } from "@/lib/auth/googleAutoVerify";

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(getAuthAdapterDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // The Credentials provider's sign-ins are never written to the adapter's `sessions`
  // table (Auth.js only persists DB sessions for adapter-linked OAuth accounts) — so
  // mixing Credentials with a database session strategy silently breaks email/password
  // login. JWT sessions work uniformly for both providers; the adapter still handles
  // user/account persistence either way.
  session: {
    strategy: "jwt",
    // Explicit rather than the 30-day default (docs/adr/0047) — bounds how
    // long a revoked-but-never-mutated session can still read a page for, on
    // top of (not instead of) the tokenVersion check on mutating routes. A
    // JWT session is rolling — every request re-signs the cookie with a
    // fresh expiry (see @auth/core's session action) — so this bounds an
    // *idle* stolen token's lifetime; an actively-used one is bounded by the
    // mutating-route check the moment it tries to do anything that matters.
    maxAge: 14 * 24 * 60 * 60,
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: authorizeCredentials,
    }),
  ],
  callbacks: {
    async signIn({ account, profile, user }) {
      if (
        shouldAutoVerifyGoogleAccount({
          provider: account?.provider,
          profileEmailVerified: Boolean(profile?.email_verified),
          userId: user?.id,
          alreadyVerified: Boolean(user?.emailVerified),
        })
      ) {
        await getDb().update(users).set({ emailVerified: new Date() }).where(eq(users.id, user!.id!));
      }
      return true;
    },
    async jwt({ token, user, trigger }) {
      if (user) {
        token.sub = user.id;
        token.tokenVersion = user.tokenVersion ?? 0;
        token.verified = Boolean(user.emailVerified);
      } else if (trigger === "update" && token.sub) {
        // The one place this callback does I/O outside of sign-in — gated on
        // an explicit client-initiated `update()` call, never on a plain
        // render (docs/adr/0047), so a Writer who just clicked a
        // verification link can refresh their session without waiting for
        // their JWT to naturally expire and without this file paying a
        // database read on every page view.
        const [row] = await getDb()
          .select({ tokenVersion: users.tokenVersion, emailVerified: users.emailVerified })
          .from(users)
          .where(eq(users.id, token.sub));
        if (row) {
          token.tokenVersion = row.tokenVersion;
          token.verified = Boolean(row.emailVerified);
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.tokenVersion = typeof token.tokenVersion === "number" ? token.tokenVersion : 0;
        session.user.verified = Boolean(token.verified);
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
}));
