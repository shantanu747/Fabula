"use client";

import { useState } from "react";

export function ReportButton({ storyId }: { storyId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function report() {
    setState("sending");
    try {
      await fetch(`/api/stories/${storyId}/report`, { method: "POST" });
      setState("sent");
    } catch {
      setState("idle");
    }
  }

  if (state === "sent") {
    return <span className="text-[11.5px] italic text-muted">Reported — thanks for flagging this.</span>;
  }

  // An underlined 11.5px text button (board 1e), not a pill. The handoff sets it
  // at 0.42 alpha; --muted is the nearest step that clears the contrast gate.
  return (
    <button
      type="button"
      onClick={report}
      disabled={state === "sending"}
      className="btn btn-text tap-target text-[11.5px] underline decoration-muted/50 underline-offset-2"
    >
      {state === "sending" ? "Reporting…" : "Report"}
    </button>
  );
}
