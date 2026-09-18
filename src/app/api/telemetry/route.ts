import { log, LOG_EVENTS } from "@/lib/observability/logger";
import { recordClientError, recordClientVital } from "@/lib/observability/metrics";
import { normalizeClientRoute } from "@/lib/observability/normalizeClientRoute";
import {
  TELEMETRY_MAX_BODY_BYTES,
  TELEMETRY_VITAL_NAMES,
  type TelemetryPayload,
} from "@/lib/observability/telemetryContract";
import { withRoute } from "@/lib/observability/withRoute";
import { guardTelemetry } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { readJsonBody } from "@/lib/http/readJsonBody";

/**
 * Client telemetry with no vendor (docs/adr/0049): Web Vitals from
 * `WebVitals.tsx` and `error.digest`-only reports from every error boundary,
 * recorded into the same OTel instruments `/api/generate` and friends write
 * to — one pipeline, not a second one for "client" data.
 *
 * Public and unauthenticated by necessity (a page's client bundle has no
 * session before one exists) — treat the body as hostile. Every field is
 * checked against a closed shape before anything is recorded; an unknown
 * `kind`, an unlisted vital `name`, or a wrong field type is rejected
 * outright rather than coerced or partially accepted. `route` is never
 * trusted verbatim as a metric attribute even once shape-valid —
 * `normalizeClientRoute` buckets it into one of this app's own known page
 * templates first, so a caller cannot mint unbounded time series just by
 * POSTing distinct strings.
 */

function isValidPayload(body: unknown): body is TelemetryPayload {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.route !== "string" || b.route.length === 0 || b.route.length > 200) return false;

  if (b.kind === "vital") {
    return (
      typeof b.name === "string" &&
      (TELEMETRY_VITAL_NAMES as readonly string[]).includes(b.name) &&
      typeof b.value === "number" &&
      Number.isFinite(b.value)
    );
  }
  if (b.kind === "error") {
    return b.digest === undefined || (typeof b.digest === "string" && b.digest.length <= 200);
  }
  return false;
}

export const POST = withRoute("/api/telemetry", async (request: Request) => {
  const originRejection = assertSameOrigin(request);
  if (originRejection) return originRejection;

  // First, not after parsing the body — this is a public, unauthenticated,
  // high-volume-by-design endpoint, so bounding raw request volume matters
  // more here than for any route that has an expensive step to protect
  // (contrast guardRegister, placed right before its bcrypt call).
  const limited = await guardTelemetry(request);
  if (limited) return limited;

  const parsed = await readJsonBody(request, TELEMETRY_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  if (!isValidPayload(parsed.body)) {
    return Response.json({ error: "Invalid telemetry payload" }, { status: 400 });
  }
  const payload = parsed.body;
  const route = normalizeClientRoute(payload.route);

  if (payload.kind === "vital") {
    recordClientVital(payload.name, payload.value, route);
  } else {
    recordClientError(route);
    // digest only, never a message or stack (docs/adr/0049) — a client
    // error's message can embed user-typed text (a story paragraph, a form
    // field) that was on screen when rendering broke; digest is Next's own
    // opaque per-error id, safe by construction.
    log.warn(LOG_EVENTS.CLIENT_ERROR, { route, digest: payload.digest });
  }

  return new Response(null, { status: 204 });
});
