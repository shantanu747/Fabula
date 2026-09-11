import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";
import { getFeedPage, type FeedRow } from "./feedAndLibrary";
import type { AppDatabase } from "./types";

const FEED_PAGE0_KEY = "feed:page0";

/**
 * Short enough that a share/unshare from a request this cache doesn't know
 * about (or a Redis eval that raced the explicit invalidation below) shows up
 * for everyone within a bounded time regardless. Long enough to matter under
 * any real traffic — page 0 of the feed is read on every visit, by everyone.
 * The explicit invalidation in PATCH /api/stories/[id] is the primary
 * mechanism; this TTL is the safety net, not the other way around
 * (docs/adr/0041).
 */
const FEED_PAGE0_TTL_SECONDS = 30;

// JSON has no Date type — round-tripped through ISO strings on the wire.
interface CachedFeedPage {
  rows: (Omit<FeedRow, "updatedAt"> & { updatedAt: string })[];
  nextCursor: string | null;
}

function toCached(page: { rows: FeedRow[]; nextCursor: string | null }): CachedFeedPage {
  return { ...page, rows: page.rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
}

function fromCached(cached: CachedFeedPage): { rows: FeedRow[]; nextCursor: string | null } {
  return { ...cached, rows: cached.rows.map((r) => ({ ...r, updatedAt: new Date(r.updatedAt) })) };
}

/**
 * Page 0 of the shared feed, Redis-cached behind `hasKv()` (docs/adr/0041) —
 * inert (a plain `getFeedPage` call every time) without Redis configured, per
 * every other Redis-backed mechanism in this app (docs/adr/0035).
 */
export async function getCachedFeedPage0(
  db: AppDatabase
): Promise<{ rows: FeedRow[]; nextCursor: string | null }> {
  if (!hasKv()) return getFeedPage(db);

  const cached = await withKvTimeout(() => getKv().get<CachedFeedPage>(FEED_PAGE0_KEY));
  if (cached) return fromCached(cached);

  const page = await getFeedPage(db);
  // Best-effort, like every other Redis write in this app — a failed cache
  // write must never fail the page render, only cost the next visitor a real
  // query instead of a cache hit.
  await withKvTimeout(() => getKv().set(FEED_PAGE0_KEY, toCached(page), { ex: FEED_PAGE0_TTL_SECONDS }));
  return page;
}

/** Called from PATCH /api/stories/[id] whenever `isShared` actually changes —
 *  page 0's membership or ordering may have just changed. */
export async function invalidateFeedPage0Cache(): Promise<void> {
  if (!hasKv()) return;
  await withKvTimeout(() => getKv().del(FEED_PAGE0_KEY));
}
