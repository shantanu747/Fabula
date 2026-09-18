import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { log, LOG_EVENTS } from "./logger";
import { resolveRequestId } from "./requestId";
import { withRequestScope } from "./requestContext";
import { recordDbRoundtrips } from "./metrics";

/**
 * Wraps every route handler under `src/app/api/**` with a span
 * (`http.route`, `http.method`, `http.status_code`, `fabula.request_id`), a
 * resolved request id echoed as `x-request-id` on every response — including
 * an error path — and consistent, structured error logging for whatever a
 * handler doesn't already catch itself (docs/adr/0049).
 *
 * `routeName` is a literal, developer-chosen path template
 * ("/api/stories/[id]"), passed explicitly at each call site rather than
 * read off `request.url` — the whole point of the cardinality rule
 * (docs/adr/0049, metrics.ts) is that a metric attribute must never carry an
 * interpolated id, and `fabula.db.roundtrips`' `route` attribute (recorded
 * here) is exactly that kind of attribute.
 *
 * Generic over the handler's own signature so this works unchanged for a
 * zero-arg handler (`/api/health`), one taking Next 16's typed
 * `RouteContext<Path>` second argument (`/api/stories/[id]`), and Auth.js's
 * own `handlers.GET`/`handlers.POST` (`/api/auth/[...nextauth]`).
 *
 * `/api/generate/route.ts` keeps its own richer `fabula.generate` span
 * (ADR 0022) — wrapping it here does not flatten that span, it becomes a
 * *child* of the `http.route` span below, exactly like every `db.*` span
 * `db/tracing.ts` emits during the same request: `context.with` below makes
 * this span the active one for the whole handler call, and OTel parents any
 * span started without an explicit context onto whatever is active.
 *
 * **`selfReportsRoundtrips`.** A streaming route's handler promise resolves
 * as soon as it returns `new Response(stream, ...)` — the `ReadableStream`'s
 * own body keeps running, and keeps making database calls, long after that
 * (`generate/route.ts` never awaits its stream's `start()` before
 * returning). Recording `fabula.db.roundtrips` from this wrapper's own
 * `finally` would therefore capture only the pre-stream round trips and
 * silently under-report the request's real total. A route whose response
 * can be a stream passes `{ selfReportsRoundtrips: true }` and calls
 * `recordDbRoundtrips(readActiveRoundtripCount(), routeName)` itself from
 * its own true completion point instead (see `generate/route.ts`'s
 * `finish()`) — the context-propagated counter (`requestContext.ts`) is
 * still accumulating correctly the whole time regardless of which side
 * reads it; this option only decides who reports the final number, once.
 */

const tracer = trace.getTracer("fabula");

type RouteHandler<Args extends unknown[]> = (request: Request, ...args: Args) => Promise<Response>;

/**
 * `Response.redirect()` (used by a couple of auth routes) and `Response.error()`
 * both produce a Response whose `headers` guard is "immutable" per the Fetch
 * spec — `.set()` throws on one. Rebuilding a new Response with a mutable
 * copy of the same headers, rather than assuming every route's response
 * supports in-place mutation, is what makes this work for every route
 * without each one needing to know or care about that distinction.
 */
function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set("x-request-id", requestId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

export function withRoute<Args extends unknown[]>(
  routeName: string,
  handler: RouteHandler<Args>,
  options: { selfReportsRoundtrips?: boolean } = {}
): RouteHandler<Args> {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const requestId = resolveRequestId(request);
    const span = tracer.startSpan("http.route", {
      attributes: {
        "http.route": routeName,
        "http.method": request.method,
        "fabula.request_id": requestId,
      },
    });

    const { result, counter } = withRequestScope(requestId, () =>
      context.with(trace.setSpan(context.active(), span), () => handler(request, ...args))
    );

    try {
      const response = await result;
      span.setAttribute("http.status_code", response.status);
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return withRequestId(response, requestId);
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR });
      log.error(LOG_EVENTS.ROUTE_ERROR, { requestId, route: routeName, err });
      return withRequestId(Response.json({ error: "Internal server error" }, { status: 500 }), requestId);
    } finally {
      if (!options.selfReportsRoundtrips && counter.count > 0) recordDbRoundtrips(counter.count, routeName);
      span.end();
    }
  };
}
