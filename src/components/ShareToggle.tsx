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

  async function toggle() {
    const next = !isShared;
    setIsSaving(true);
    setIsShared(next); // optimistic
    try {
      const response = await fetch(`/api/stories/${storyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isShared: next }),
      });
      if (!response.ok) setIsShared(!next); // revert on failure
    } catch {
      setIsShared(!next);
    } finally {
      setIsSaving(false);
    }
  }

  // Shared reads as the outlined primary (accent stroke), unshared as the quiet
  // secondary — state carried by the stroke, never by a fill.
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isSaving}
      className={isShared ? "btn btn-primary btn-xs tap-target" : "btn btn-secondary btn-xs tap-target"}
    >
      {isShared ? "Shared to feed" : "Share to feed"}
    </button>
  );
}
