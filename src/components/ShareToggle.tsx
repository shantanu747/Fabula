"use client";

import { useState } from "react";

export function ShareToggle({
  storyId,
  initialShared,
}: {
  storyId: string;
  initialShared: boolean;
}) {
  const [isShared, setIsShared] = useState(initialShared);
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);

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
