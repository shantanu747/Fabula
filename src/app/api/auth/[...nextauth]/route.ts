import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withRoute } from "@/lib/observability/withRoute";

// Auth.js's own handlers are typed against NextRequest specifically; every
// real request Next.js hands a route handler already is one (NextRequest
// extends Request) — withRoute's own signature stays the generic Web
// standard Request every other route uses, so this cast is the one place
// that gap is bridged, not a loosening of withRoute itself.
export const GET = withRoute("/api/auth/[...nextauth]", (request: Request) => handlers.GET(request as NextRequest));
export const POST = withRoute("/api/auth/[...nextauth]", (request: Request) => handlers.POST(request as NextRequest));
