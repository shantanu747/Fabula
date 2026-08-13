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
    return <span className="text-xs text-muted">Reported — thanks for flagging this.</span>;
  }

  return (
    <button
      type="button"
      onClick={report}
      disabled={state === "sending"}
      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
    >
      {state === "sending" ? "Reporting…" : "Report"}
    </button>
  );
}
