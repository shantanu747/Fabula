"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";

export function AppHeader() {
  const { data: session, status } = useSession();

  return (
    <div className="flex w-full items-center justify-between gap-3 py-3 text-sm">
      <Link
        href="/"
        className="font-serif text-base font-semibold tracking-tight text-foreground"
      >
        Fabula
      </Link>

      <div className="flex items-center gap-3">
        {status === "authenticated" ? (
          <>
            <Link
              href="/library"
              className="text-xs font-medium text-muted transition-colors hover:text-accent"
            >
              My library
            </Link>
            <Link
              href="/feed"
              className="text-xs font-medium text-muted transition-colors hover:text-accent"
            >
              Feed
            </Link>
            <span className="hidden text-xs text-muted sm:inline">
              {session.user?.name ?? session.user?.email}
            </span>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/" })}
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-accent"
            >
              Sign out
            </button>
          </>
        ) : status === "loading" ? (
          <span className="text-xs text-muted">…</span>
        ) : (
          <>
            <Link
              href="/login"
              className="text-xs font-medium text-muted transition-colors hover:text-accent"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              Sign up
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
