"use client";

import { useState } from "react";

export function ReportButton({ storyId }: { storyId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function report() {
    setState("sending");
    try {
      const response = await fetch(`/api/stories/${storyId}/report`, { method: "POST" });
      setState(response.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return <span className="text-[11.5px] italic text-muted">Reported — thanks for flagging this.</span>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      {/* An underlined 11.5px text button (board 1e), not a pill. The handoff
          sets it at 0.42 alpha; --muted is the nearest step that clears the
          contrast gate. */}
      <button
        type="button"
        onClick={report}
        disabled={state === "sending"}
        className="btn btn-text tap-target text-[11.5px] underline decoration-muted/50 underline-offset-2"
      >
        {state === "sending" ? "Reporting…" : state === "error" ? "Try again" : "Report"}
      </button>
      {state === "error" && (
        <span role="alert" className="text-[11.5px] italic text-muted">
          Couldn&apos;t send that — try again?
        </span>
      )}
    </span>
  );
}
