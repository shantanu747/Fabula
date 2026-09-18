"use client";

import { useReportWebVitals } from "next/web-vitals";
import {
  TELEMETRY_ENDPOINT,
  TELEMETRY_VITAL_NAMES,
  type TelemetryPayload,
  type TelemetryVitalName,
} from "@/lib/observability/telemetryContract";

/**
 * Posts Core Web Vitals to `/api/telemetry` — no vendor SDK, no third-party
 * script (docs/adr/0049; ADR 0024's CSP would otherwise have to loosen to
 * allow one). Mounted once from the root layout, never per-route, per
 * Next's own guidance for confining this hook's `"use client"` boundary
 * (node_modules/next/dist/docs's analytics guide).
 *
 * Only forwards the four named vitals this app tracks (docs/adr/0049) —
 * `useReportWebVitals` also reports FCP and Next's own hydration/render
 * timings, silently dropped here rather than given a fifth server-side
 * bucket this plan never asked for.
 */
function isTrackedVital(name: string): name is TelemetryVitalName {
  return (TELEMETRY_VITAL_NAMES as readonly string[]).includes(name);
}

function send(payload: TelemetryPayload): void {
  const body = JSON.stringify(payload);
  // sendBeacon survives the page unloading mid-request (a navigation or tab
  // close right as a vital fires) — fetch's keepalive is the fallback for a
  // browser without it, same as Next's own documented pattern.
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(TELEMETRY_ENDPOINT, new Blob([body], { type: "application/json" }));
    return;
  }
  void fetch(TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Best-effort, always — a dropped telemetry report must never surface
    // to the Writer or retry into a loop.
  });
}

export function WebVitals() {
  useReportWebVitals((metric) => {
    if (!isTrackedVital(metric.name)) return;
    send({
      kind: "vital",
      name: metric.name,
      value: metric.value,
      route: typeof window !== "undefined" ? window.location.pathname : "",
    });
  });

  return null;
}
