"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

export function ShareToggle({
  storyId,
  initialShared,
}: {
  storyId: string;
  initialShared: boolean;
}) {
  const { data: session } = useSession();
  const [isShared, setIsShared] = useState(initialShared);
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  async function toggle() {
    const next = !isShared;
    setIsSaving(true);
    setIsShared(next); // optimistic
    setHasError(false);
    try {
      const response = await fetch(`/api/stories/${storyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isShared: next }),
      });
      if (!response.ok) {
        setIsShared(!next); // revert on failure
        setHasError(true);
      }
    } catch {
      setIsShared(!next);
      setHasError(true);
    } finally {
      setIsSaving(false);
    }
  }

  async function resendVerification() {
    setResendSent(true);
    await fetch("/api/auth/verify/request", { method: "POST" }).catch(() => {});
  }

  // Unverified Writers can still write (US-6/guest parity), just not share —
  // the one action with a third-party consequence (docs/adr/0046). Enforced
  // server-side by PATCH /api/stories/[id] regardless of this client check;
  // this is only what makes the gate visible before a Writer hits it.
  if (session?.user && !session.user.verified) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" disabled className="btn btn-secondary btn-xs tap-target opacity-60">
          Share to feed
        </button>
        <span className="text-[11.5px] italic text-muted">
          {resendSent ? (
            "Verification email sent — check your inbox."
          ) : (
            <>
              Verify your email to share.{" "}
              <button
                type="button"
                onClick={resendVerification}
                className="tap-target not-italic text-accent-text underline decoration-accent/50 underline-offset-2"
              >
                Resend link
              </button>
            </>
          )}
        </span>
      </span>
    );
  }

  // Shared reads as the outlined primary (accent stroke), unshared as the quiet
  // secondary — state carried by the stroke, never by a fill.
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={isSaving}
        className={isShared ? "btn btn-primary btn-xs tap-target" : "btn btn-secondary btn-xs tap-target"}
      >
        {isShared ? "Shared to feed" : "Share to feed"}
      </button>
      {hasError && (
        <span role="alert" className="text-[11.5px] italic text-muted">
          Couldn&apos;t update sharing — try again?
        </span>
      )}
    </span>
  );
}
