import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { buildCsp, cspHeaderName } from "@/lib/security/csp";
import { resolveRequestId } from "@/lib/observability/requestId";

const PROTECTED_PREFIXES = ["/library", "/feed"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function withSecurityHeaders(response: NextResponse, headerName: string, csp: string, requestId: string): NextResponse {
  response.headers.set(headerName, csp);
  response.headers.set("x-request-id", requestId);
  return response;
}

/**
 * Mints (or validates and echoes) a request id here, at the true network
 * edge, for the page-rendering path this file already matches — before any
 * route handler sees the request (docs/adr/0049). `withRoute.ts`
 * independently resolves and validates one for every `src/app/api/**`
 * route regardless of what happens here (that's what actually satisfies
 * "every request carries a request id, correlated into every log line" —
 * nothing under `/api` is logged from this file), so this is deliberately
 * *not* accompanied by widening `config.matcher` to include `/api`: doing
 * that would run `auth()` and CSP nonce construction on every API call too,
 * a real behavior and performance change to an already-tested subsystem
 * (ADR 0024) for no benefit `withRoute.ts` doesn't already provide.
 * `resolveRequestId` is what applies the log-injection validation
 * (`requestId.ts`) to an inbound `x-request-id` on a page request, same as
 * it does for every API route.
 */
export async function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const nonce = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === "development";
  const reportOnly = process.env.CSP_REPORT_ONLY === "true";
  const csp = buildCsp({ nonce, isDev });
  const headerName = cspHeaderName(reportOnly);

  // A redirect must carry the same headers as any other response — the auth check runs
  // first, on request headers alone, so it never needs the nonce/CSP that only the
  // response side (and Next's own script rendering) cares about.
  if (isProtectedPath(request.nextUrl.pathname)) {
    const session = await auth();
    if (!session) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
      return withSecurityHeaders(NextResponse.redirect(loginUrl), headerName, csp, requestId);
    }
  }

  // Set on the request too, not just the response: Next reads the nonce back out of the
  // request's own CSP header while rendering, to attach it to its framework/page scripts.
  // x-request-id travels the same way, so a page-rendering error (onRequestError,
  // a Server Component throw) could in principle correlate back to this id too.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(headerName, csp);
  requestHeaders.set("x-request-id", requestId);

  return withSecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    headerName,
    csp,
    requestId
  );
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
