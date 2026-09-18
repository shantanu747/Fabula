import { TELEMETRY_ENDPOINT, type TelemetryPayload } from "./telemetryContract";

/**
 * Shared by every `error.tsx`/`global-error.tsx` boundary in this app —
 * `error.digest` and the route only, posted to `/api/telemetry`, never the
 * error's `message` or `stack` (docs/adr/0049): production strips the
 * message from what a Server Component error boundary even receives, but
 * this function's own contract holds regardless of that, since a client
 * render error's message can legitimately contain on-screen user text.
 * `"use client"`-safe: no server-only import, matching the plan's gotcha
 * against pulling the server logger/metrics into a client module.
 */
export function reportClientError(digest: string | undefined, route: string): void {
  const payload: TelemetryPayload = { kind: "error", digest, route };
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(TELEMETRY_ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // An error boundary is the last place a further throw can go anywhere
    // useful — telemetry reporting must never compound the failure it's
    // reporting on.
  }
}
