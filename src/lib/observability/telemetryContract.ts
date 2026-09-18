/**
 * The `/api/telemetry` wire contract, shared verbatim between the client
 * component that posts to it (`WebVitals.tsx`, the error boundaries) and the
 * route handler that validates against it — one literal list, not two kept
 * in sync by hand. Safe to import from a `"use client"` module: no
 * server-only code, matching the plan's "never import the server logger or
 * metrics into a client module" gotcha (docs/adr/0049).
 */

export const TELEMETRY_VITAL_NAMES = ["LCP", "INP", "CLS", "TTFB"] as const;
export type TelemetryVitalName = (typeof TELEMETRY_VITAL_NAMES)[number];

export type TelemetryPayload =
  | { kind: "vital"; name: TelemetryVitalName; value: number; route: string }
  | { kind: "error"; digest?: string; route: string };

export const TELEMETRY_ENDPOINT = "/api/telemetry";

/** Bytes, not characters — comfortably over the largest real payload (a
 *  `route` string plus a handful of numeric/short fields) while still small
 *  enough that even an adversarial body this endpoint's own size check
 *  admits can't carry anything useful beyond the fields validated below. */
export const TELEMETRY_MAX_BODY_BYTES = 1024;
