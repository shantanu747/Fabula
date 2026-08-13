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

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isSaving}
      className={
        isShared
          ? "rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          : "rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
      }
    >
      {isShared ? "Shared to feed" : "Share to feed"}
    </button>
  );
}
