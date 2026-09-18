import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";
import { recordProviderCircuit } from "@/lib/observability/metrics";

/**
 * Per-provider circuit breaker (docs/adr/0045-provider-circuit-breaker.md).
 *
 * Extends ADR 0023's Writer-mediated failover — it does not replace it. The
 * Writer is still *asked* before a fallback provider is used; this module
 * only changes how quickly the 502-with-suggestion arrives once a provider is
 * known to be down, so nobody pays the full `FIRST_CHUNK_TIMEOUT_MS` (20s)
 * during an outage the app already has fifty recent data points about.
 *
 * Same fail-open posture as `src/lib/admission/lease.ts` (docs/adr/0035):
 * bounding latency during an outage is an optimisation, not the product, so
 * a Redis outage must degrade to "exactly today's behaviour" — every request
 * attempts the provider directly — never to "every request refused."
 */

/** Consecutive qualifying failures before the breaker opens. A judgment call,
 *  not a measurement — this app has no production traffic history yet (the
 *  same gap ADR 0023 cited when it rejected circuit breaking the first time).
 *  Low enough that a real outage trips it well within its first few requests;
 *  high enough that one-off blips (the kind the existing single same-provider
 *  retry in route.ts already absorbs) don't. Revisit once real traffic exists. */
const FAILURE_THRESHOLD = 5;

/** How long the breaker stays open before allowing one probe through. Short
 *  enough that a resolved outage recovers quickly; long enough that a probe
 *  isn't sent into the same outage every few requests. */
const COOLDOWN_MS = 30_000;

/** Bounds how long a single probe can hold the "probing" claim before a new
 *  one may be attempted — must exceed FIRST_CHUNK_TIMEOUT_MS (20s) so a
 *  legitimate slow probe isn't pre-empted by a second one, but still self-heal
 *  if the probing request's process dies without ever reporting an outcome
 *  (the same "a crashed isolate must not leak a slot forever" reasoning as
 *  lease.ts's LEASE_TTL_SECONDS). */
const PROBE_LOCK_TTL_SECONDS = 30;

/** TTL on the breaker's own state, refreshed on every write. Bounds how long
 *  a stale failure count can linger if a provider recovers without ever
 *  producing the one more success that would reset it. */
const STATE_TTL_SECONDS = 300;

function stateKey(providerId: string): string {
  return `breaker:${providerId}:state`;
}

function probeKey(providerId: string): string {
  return `breaker:${providerId}:probe`;
}

export type BreakerDecision =
  /** `isProbe: true` marks the one caller allowed through during a half-open
   *  cooldown — its outcome (recorded via `recordBreakerOutcome`) decides
   *  whether the breaker closes or re-opens. Every other caller sees
   *  `isProbe: false`, identical to the normal closed-breaker case; the
   *  caller does not need to treat them differently going in, only when
   *  reporting the outcome (see `recordBreakerOutcome`'s doc comment). */
  | { allowed: true; isProbe: boolean }
  | { allowed: false };

/**
 * Atomic: reads the breaker's state and, if the cooldown has just elapsed,
 * claims the probe slot in the same script execution — Redis serialises
 * script execution, so however many callers race this at once, exactly one
 * can win the `SET NX` and become the probe.
 */
const CHECK_SCRIPT = `
local stateKey = KEYS[1]
local probeKey = KEYS[2]
local now = tonumber(ARGV[1])
local cooldownMs = tonumber(ARGV[2])
local probeLockTtl = tonumber(ARGV[3])

local state = redis.call('HGET', stateKey, 'state')
if state ~= 'open' then
  return 'allow'
end

local openedAt = tonumber(redis.call('HGET', stateKey, 'openedAt')) or 0
if now - openedAt < cooldownMs then
  return 'deny'
end

local claimed = redis.call('SET', probeKey, '1', 'NX', 'EX', probeLockTtl)
if claimed then
  return 'probe'
end
return 'deny'
`;

/**
 * Whether `providerId` may be attempted right now, and whether this caller is
 * the probe. Fails open (allow, not-a-probe) when Redis is unavailable, slow,
 * or throws — identical reasoning to `acquireLease`.
 */
export async function checkBreaker(providerId: string): Promise<BreakerDecision> {
  if (!hasKv()) return { allowed: true, isProbe: false };

  const result = await withKvTimeout(() =>
    getKv().eval<string[], string>(
      CHECK_SCRIPT,
      [stateKey(providerId), probeKey(providerId)],
      [String(Date.now()), String(COOLDOWN_MS), String(PROBE_LOCK_TTL_SECONDS)]
    )
  );

  if (result === undefined || result === "allow") return { allowed: true, isProbe: false };
  if (result === "probe") {
    recordProviderCircuit(providerId, "probe_allowed");
    return { allowed: true, isProbe: true };
  }
  return { allowed: false };
}

/**
 * A success (`DEL`s both keys — back to fully closed, failure count included)
 * unconditionally closes the breaker, whether it came from an ordinary closed
 * -state attempt or from the probe: a probe succeeding is exactly what's
 * supposed to close it again.
 *
 * A failure either counts toward the threshold (closed/counting state) or, if
 * this was the probe, re-opens immediately and restarts the cooldown — the
 * probe itself IS the "one more confirming failure" here, deliberately not
 * requiring another five before re-opening.
 */
// Returns 2 when this call just (re-)opened the breaker — either branch that
// sets state='open', including the probe-failed re-open — and 1 when it only
// advanced the failure count without transitioning state. recordBreakerOutcome
// uses that distinction to record a `fabula.provider.circuit` "opened"
// transition exactly once per real state change, not once per failure.
const RECORD_FAILURE_SCRIPT = `
local stateKey = KEYS[1]
local probeKey = KEYS[2]
local now = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local stateTtl = tonumber(ARGV[3])

redis.call('DEL', probeKey)

local state = redis.call('HGET', stateKey, 'state')
if state == 'open' then
  redis.call('HSET', stateKey, 'state', 'open', 'openedAt', tostring(now))
  redis.call('EXPIRE', stateKey, stateTtl)
  return 2
end

local failures = tonumber(redis.call('HINCRBY', stateKey, 'failures', 1))
redis.call('EXPIRE', stateKey, stateTtl)
if failures >= threshold then
  redis.call('HSET', stateKey, 'state', 'open', 'openedAt', tostring(now))
  return 2
end
return 1
`;

/**
 * Records the outcome of a call this breaker actually allowed through
 * (`checkBreaker` returned `allowed: true`) — never call this for a request
 * the breaker itself denied, and never for an outcome that doesn't indicate
 * provider health (a provider 429 is quota, not health; a client disconnect
 * says nothing about the provider at all). Best-effort: a failed Redis write
 * here just means the breaker under- or over-counts by one, never a thrown
 * error the caller has to handle.
 */
export async function recordBreakerOutcome(providerId: string, outcome: "success" | "failure"): Promise<void> {
  if (!hasKv()) return;

  if (outcome === "success") {
    const deleted = await withKvTimeout(() => getKv().del(stateKey(providerId), probeKey(providerId)));
    // `del`'s own return is the count of keys that actually existed — 0 means
    // there was no failure-tracking state to clear (the ordinary case: a
    // success from a breaker that was already closed), so only a non-zero
    // count is a real open/counting-to-closed transition worth recording.
    if (deleted !== undefined && deleted > 0) recordProviderCircuit(providerId, "closed");
    return;
  }

  const result = await withKvTimeout(() =>
    getKv().eval<string[], number>(
      RECORD_FAILURE_SCRIPT,
      [stateKey(providerId), probeKey(providerId)],
      [String(Date.now()), String(FAILURE_THRESHOLD), String(STATE_TTL_SECONDS)]
    )
  );
  if (result === 2) recordProviderCircuit(providerId, "opened");
}

/** Whether a thrown provider-SDK error is a 429 (quota/rate-limit), which
 *  must never count toward the breaker — opening it on a throttle turns a
 *  temporary "slow down" into a full outage for every other Writer.
 *  `@anthropic-ai/sdk` and `openai` (OpenRouter uses the OpenAI SDK) both
 *  throw an `APIError` carrying the HTTP status on `.status`. */
export function isProviderQuotaError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 429
  );
}
