import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";

/**
 * Per-user and global in-flight generation caps.
 *
 * A rate limit bounds requests per unit time; it says nothing about how many
 * of those requests are open *right now*. `GENERATE_USER`'s capacity of 20
 * lets one account open twenty simultaneous streams against the one shared
 * provider key this app holds per provider (`registry.ts`) — this module is
 * the thing that actually bounds concurrency.
 *
 * Admission control fails open to no limiting at all when Redis is
 * unavailable (docs/adr/0035): bounding concurrency is a cost optimisation,
 * writing is the product, and a Redis outage must never stop people writing.
 */

/** How many generations one account (or the shared guest bucket) may have open at once. */
const PER_IDENTITY_CAP = 2;

/**
 * How many generations the whole app may have open at once, regardless of how
 * many distinct callers there are. Sized well above any realistic legitimate
 * load at today's traffic (bench/BASELINE.md measured ~3.4 turns/s to
 * completion against a fast mock provider, so dozens of real, slower-provider
 * generations in flight at once is a generous ceiling, not a tight one) and
 * well below what would let a single leak or a coordinated abuse pattern
 * exhaust the shared provider key. A constant to tune once real traffic
 * exists, same posture as ADR 0015's rate-limit numbers.
 */
const GLOBAL_CAP = 50;

/**
 * A crashed isolate must not leak a slot forever — without a TTL, one crash
 * permanently reduces capacity and the only fix is a manual Redis edit.
 * Sized to the longest a generation can legitimately still be running:
 * `maxDuration` (60s, see route.ts) plus margin for the time between the
 * lease's acquisition and the function actually returning.
 */
const LEASE_TTL_SECONDS = 90;

const GLOBAL_KEY = "admission:global";

function identityKey(identity: string): string {
  return `admission:identity:${identity}`;
}

export type LeaseResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; retryAfterSeconds: number };

/**
 * Atomically checks both caps and increments both counters only if neither is
 * exceeded — the same "one script, no interleaving" reasoning as the rate
 * limiter's Lua bucket. Two separate INCR/DECR pairs would let a caller slip
 * through between the identity check passing and the global check running.
 */
const ACQUIRE_SCRIPT = `
local identityKey = KEYS[1]
local globalKey = KEYS[2]
local identityCap = tonumber(ARGV[1])
local globalCap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local identityCount = tonumber(redis.call('GET', identityKey)) or 0
local globalCount = tonumber(redis.call('GET', globalKey)) or 0

if identityCount >= identityCap or globalCount >= globalCap then
  return 0
end

redis.call('INCR', identityKey)
redis.call('EXPIRE', identityKey, ttl)
redis.call('INCR', globalKey)
redis.call('EXPIRE', globalKey, ttl)
return 1
`;

/**
 * `DECR` rather than `DEL`, and clamped at zero: two releases for the same
 * acquisition (the double-release this module is explicitly built to
 * tolerate — see `release`'s own idempotency) must not push a counter
 * negative, which would hand out phantom extra capacity to everyone after it
 * until the TTL clears the key.
 */
const RELEASE_SCRIPT = `
local key = KEYS[1]
local count = tonumber(redis.call('GET', key)) or 0
if count > 0 then
  redis.call('DECR', key)
end
return 1
`;

async function releaseOnce(identity: string): Promise<void> {
  await withKvTimeout(async () => {
    await getKv().eval(RELEASE_SCRIPT, [identityKey(identity)], []);
    await getKv().eval(RELEASE_SCRIPT, [GLOBAL_KEY], []);
  });
  // A release that fails (timeout, Redis down) just leaves the slot occupied
  // until LEASE_TTL_SECONDS clears it — the leak this module exists to bound,
  // not one it can also fix retroactively without a live Redis to talk to.
}

/**
 * Acquires a lease for `identity`, or reports how long to wait.
 *
 * Fails open when Redis is unavailable: returns `acquired: true` with a
 * no-op `release`, exactly the "no concurrency limiting" state this app was
 * already in before this module existed. A Redis outage denying every
 * generation would be a worse outage than the one admission control exists to
 * prevent.
 */
export async function acquireLease(identity: string): Promise<LeaseResult> {
  if (!hasKv()) {
    return { acquired: true, release: async () => {} };
  }

  const result = await withKvTimeout(() =>
    getKv().eval<string[], number>(
      ACQUIRE_SCRIPT,
      [identityKey(identity), GLOBAL_KEY],
      [String(PER_IDENTITY_CAP), String(GLOBAL_CAP), String(LEASE_TTL_SECONDS)]
    )
  );

  // Redis threw or timed out — fail open, same reasoning as the `!hasKv()` case.
  if (result === undefined) {
    return { acquired: true, release: async () => {} };
  }

  if (result === 0) {
    // A concurrency refusal has no bucket to read a real wait time from —
    // unlike the rate limiter, nothing here refills on a schedule the client
    // can usefully wait out. A short, fixed suggestion is honest: "try again
    // in a few seconds," not a computed number that implies more precision
    // than a slot becoming free actually has.
    return { acquired: false, retryAfterSeconds: 5 };
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      // Idempotent: every caller (route.ts's `finish()`) must be able to call
      // this without tracking whether it already has, since finish() itself
      // can run from more than one code path guarded by finishedOnce.
      if (released) return;
      released = true;
      await releaseOnce(identity);
    },
  };
}
