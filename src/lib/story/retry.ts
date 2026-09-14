/**
 * Client-side backoff for two distinct failure classes — see
 * docs/adr/0044-durable-writer-turns-and-idempotent-creation.md for why this
 * does not reopen ADR 0023's rejection of backoff for a *provider* that's
 * slow or down. That rejection was about making the Writer wait longer
 * before learning a provider has failed; this module never retries a
 * provider-unavailable/timeout/turn-violation/bad-request outcome. It backs
 * off only `kind: "network"` (our own fetch to `/api/generate` or
 * `/api/stories` never reaching the server at all — a dropped wifi handoff,
 * a backgrounded tab, a DNS blip) and the idempotent story-creation POST,
 * both short-lived transport failures worth a few silent, bounded attempts
 * rather than surfacing every mobile connection flicker as an error.
 */

/** Full jitter (AWS's term for it): each delay is drawn uniformly from
 *  [0, cap), not `base * 2^attempt` plus a small wobble. Anything less than
 *  full jitter still lets a population of clients that all failed at the same
 *  instant (a provider or network blip affecting many Writers at once)
 *  re-attempt in a correlated burst — the thundering herd this exists to
 *  prevent. */
export interface BackoffPolicy {
  /** Total attempts, including the first — not the retry count. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const NETWORK_RETRY_POLICY: BackoffPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

/**
 * The delay before retry number `attempt` (0-indexed: 0 is the delay before
 * the *second* overall attempt). Exponential cap, uniform-random draw under it.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  const cap = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.random() * cap;
}

/**
 * Parses `Retry-After` in either form RFC 9110 allows: an integer number of
 * seconds, or an HTTP-date. Returns milliseconds from now, floored at 0 (a
 * date already in the past means "now"). `undefined` for anything that's
 * neither — a malformed header must never be surfaced as a bogus wait.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  // The delay-seconds form is specifically a non-negative integer (RFC 9110
  // §10.2.3) — reject "1.5", "-1", "1e3", and anything Number() would parse
  // more liberally than the spec allows before falling through to the date form.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // The one HTTP-date format RFC 9110 §5.6.7 actually permits on the wire
  // (IMF-fixdate) — matched explicitly rather than trusting Date.parse alone,
  // which is notoriously loose and will happily "parse" a bare number like
  // "1.5" as a date in some engines. Date.parse still does the real parsing
  // once the shape is confirmed; this regex only gates which shapes reach it.
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
  }

  return undefined;
}

/** Retryable outcomes, shared with the generation error surface — a
 *  `turn-violation` or `bad-request` is never one of these, by construction:
 *  callers pass only the kinds they've already decided are worth another try. */
export type RetryableFailure = { retryable: true } | { retryable: false };

/**
 * Runs `attempt`, retrying on a thrown error `shouldRetry` accepts, up to
 * `policy.maxAttempts` total tries, sleeping `backoffDelayMs` between them.
 * The last failure's error is what ultimately propagates — this never hides
 * that every attempt failed, only delays reporting it.
 */
export async function withBackoff<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  policy: BackoffPolicy,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await attempt(attemptIndex);
    } catch (err) {
      if (attemptIndex >= policy.maxAttempts - 1 || !shouldRetry(err)) throw err;
      await sleep(backoffDelayMs(attemptIndex, policy));
    }
  }
}
