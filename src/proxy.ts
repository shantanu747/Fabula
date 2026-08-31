import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";

// src/auth.ts configures NextAuth with a lazy config factory (deliberately —
// see its comment on getAuthAdapterDb()), and under that form auth(handler)
// — the middleware-wrapping overload, used only here — resolves to a Promise
// of the wrapped handler rather than the handler itself. Every other call
// site in the app uses the zero-argument `await auth()` session-read form,
// where that makes no difference. Next.js requires proxy.ts to export a
// plain function, not a Promise, so the promise is awaited inside one; it's
// created once at module scope, so later requests await an already-settled
// promise rather than re-invoking auth().
const wrappedAuthProxy = auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
});

export async function proxy(request: NextRequest, ctx: Parameters<Awaited<typeof wrappedAuthProxy>>[1]) {
  return (await wrappedAuthProxy)(request, ctx);
}

export const config = {
  matcher: ["/library/:path*", "/feed/:path*"],
};
