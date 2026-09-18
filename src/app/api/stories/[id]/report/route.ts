import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { stories, storyReports } from "@/lib/db/schema";
import { guardReport } from "@/lib/ratelimit/guard";
import { assertSameOrigin } from "@/lib/security/assertSameOrigin";
import { assertSessionCurrent } from "@/lib/auth/tokenVersion";
import { withRoute } from "@/lib/observability/withRoute";

// The route this hardening was written for: no body of any kind, which
// makes it a CORS-*simple* request (no preflight) and therefore forgeable
// from a bare cross-site <form> without the Origin check below (docs/adr/0048).
export const POST = withRoute(
  "/api/stories/[id]/report",
  async (request: Request, { params }: RouteContext<"/api/stories/[id]/report">) => {
    const originRejection = assertSameOrigin(request);
    if (originRejection) return originRejection;

    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const revoked = await assertSessionCurrent(session.user);
    if (revoked) return revoked;
    const limited = await guardReport(session.user.id);
    if (limited) return limited;
    const { id } = await params;

    const db = getDb();
    // Only the shared-status check reads this row — explicit columns, not SELECT *.
    const [story] = await db.select({ isShared: stories.isShared }).from(stories).where(eq(stories.id, id));
    if (!story || !story.isShared) {
      return Response.json({ error: "Story not found" }, { status: 404 });
    }

    // Unique(storyId, reporterId) makes a repeat report from the same reader a no-op,
    // not an error — there's no moderation queue in this pass to spam either way.
    await db
      .insert(storyReports)
      .values({ storyId: id, reporterId: session.user.id })
      .onConflictDoNothing({ target: [storyReports.storyId, storyReports.reporterId] });

    return Response.json({ ok: true });
  }
);
