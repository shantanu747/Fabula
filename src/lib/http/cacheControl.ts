/**
 * Every read route this touches is per-user or logged-in-only (docs/adr/0010)
 * — a shared/proxy cache holding one Writer's library or the feed as seen by
 * one particular caller would be a data leak. `no-store`, not just
 * `private`: none of these routes support conditional requests (no ETag/
 * Last-Modified), so a browser reusing a `private` response without
 * revalidating it would just show stale data with no way to detect it —
 * simpler and safer to say "never cache this" outright (docs/adr/0041).
 */
export const PRIVATE_NO_STORE = "private, no-store";
