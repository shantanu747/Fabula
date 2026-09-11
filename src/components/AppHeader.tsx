"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { Wordmark } from "@/components/Logo";

// 12px Lora, muted, warming to the accent text step on hover (README "Start
// flow" header). .tap-target lifts each to a 44px touch area.
export const NAV_LINK = "tap-target text-[12px] text-muted transition-colors hover:text-accent-text";

/** The session cluster: library, feed and sign-out when signed in; sign-in and
 *  create-account for a guest unless the caller supplies its own guest action. */
export function AuthLinks({ guestLinks = true }: { guestLinks?: boolean }) {
  const { data: session, status } = useSession();

  if (status === "authenticated") {
    return (
      <>
        <Link href="/library" className={NAV_LINK}>
          My library
        </Link>
        {/* prefetch={false}: this Link is visible on every authenticated page,
            so default (viewport-triggered) prefetching would fire a background
            request to /feed well before a Writer actually clicks it —
            needless load against feedCache.ts's server-side cache (and the
            query behind it) for a page whose whole value is showing what's
            currently shared, not what was shared whenever the link happened
            to scroll into view. */}
        <Link href="/feed" prefetch={false} className={NAV_LINK}>
          Feed
        </Link>
        {/* data-testid, not a role/text query: the name/email varies per test
            run (e2e/helpers/auth.ts's uniqueEmail()), so visual.spec.ts needs
            a stable hook to mask it rather than something to match against. */}
        <span data-testid="session-user" className="hidden text-[12px] italic text-muted lg:inline">
          {session.user?.name ?? session.user?.email}
        </span>
        <button type="button" onClick={() => signOut({ callbackUrl: "/" })} className={NAV_LINK}>
          Sign out
        </button>
      </>
    );
  }
  if (status === "loading") {
    return <span className="text-[12px] text-muted">…</span>;
  }
  if (!guestLinks) return null;
  return (
    <>
      <Link href="/login" className={NAV_LINK}>
        Sign in
      </Link>
      <Link
        href="/signup"
        className="tap-target text-[12px] text-accent-text underline decoration-accent/50 underline-offset-2"
      >
        Create an account
      </Link>
    </>
  );
}

/**
 * The full-width header band: 58px on desktop, 52px on a phone, one hairline
 * below (README "Start flow" header; board 1g for the mobile fold).
 *
 * The story canvas passes `meta` (theme · characters, after a 1px × 20px
 * divider), `actions` (Save / Share / New story), `aside` (the paragraph count
 * shown only where the arc rail has folded away) and `progress` (the 2px bar
 * that replaces the rail below the desktop breakpoint). On a phone the canvas
 * hides the actions and the auth links here and repeats them in its own footer,
 * so the 52px band carries only mark, theme and count.
 */
export function AppHeader({
  meta,
  actions,
  aside,
  progress,
  variant = "default",
}: {
  meta?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  progress?: number;
  variant?: "default" | "canvas";
}) {
  const canvas = variant === "canvas";
  return (
    <header className="w-full border-b border-border">
      <div className="flex h-[52px] items-center gap-3 px-[22px] md:h-[58px] md:gap-4 md:px-9">
        <Link href="/" className="tap-target shrink-0" aria-label="Fabula home">
          <Wordmark />
        </Link>

        {meta ? (
          <>
            <span aria-hidden="true" className="hidden h-5 w-px shrink-0 bg-border md:block" />
            <p className="min-w-0 flex-1 truncate text-[12.5px] italic text-muted">{meta}</p>
          </>
        ) : (
          <span className="flex-1" />
        )}

        {aside && <span className="shrink-0 text-[12px] tabular-nums text-muted lg:hidden">{aside}</span>}

        <div className={`${canvas ? "hidden md:flex" : "flex"} shrink-0 items-center gap-5`}>
          {actions}
          <AuthLinks guestLinks={!canvas} />
        </div>
      </div>

      {progress !== undefined && (
        // Presentation attributes, not an inline style: the production CSP has
        // no 'unsafe-inline' for style-src-attr.
        <svg aria-hidden="true" className="block h-[2px] w-full lg:hidden" preserveAspectRatio="none">
          <rect x="0" y="0" width="100%" height="2" className="fill-foreground/12" />
          <rect x="0" y="0" width={`${Math.round(progress * 100)}%`} height="2" className="fill-accent" />
        </svg>
      )}
    </header>
  );
}
