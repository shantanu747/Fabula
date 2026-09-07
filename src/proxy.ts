import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { buildCsp, cspHeaderName } from "@/lib/security/csp";

const PROTECTED_PREFIXES = ["/library", "/feed"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function withSecurityHeaders(response: NextResponse, headerName: string, csp: string): NextResponse {
  response.headers.set(headerName, csp);
  return response;
}

export async function proxy(request: NextRequest) {
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
      return withSecurityHeaders(NextResponse.redirect(loginUrl), headerName, csp);
    }
  }

  // Set on the request too, not just the response: Next reads the nonce back out of the
  // request's own CSP header while rendering, to attach it to its framework/page scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(headerName, csp);

  return withSecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    headerName,
    csp
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
