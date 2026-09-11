import { getKv, hasKv, withKvTimeout } from "@/lib/kv/client";
import { sumGlobalCostSince, sumGuestCostSince, sumUserCostSince } from "@/lib/db/generationEvents";
import type { AppDatabase } from "@/lib/db/types";

/**
 * Daily spend caps, enforced from `generation_event.costUsd` (recorded since
 * ADR 0022, never read back until now).
 *
 * A per-user cap of $2/day at roughly $0.016/generation worst case (Claude
 * Sonnet 5's $2/$10-per-MTok pricing against `MAX_OUTPUT_TOKENS`, `pricing.ts`)
 * allows well over a hundred generations — far more than one co-writing
 * session needs — while bounding what a single compromised or runaway account
 * can spend before the next day's reset. A constant to tune once real traffic
 * exists, same posture as ADR 0015's rate-limit numbers.
 */
const PER_USER_DAILY_CAP_USD = 2;

/**
 * Guests share this one budget rather than one each — see `guestKey()`'s doc
 * comment for why. Sized at a modest multiple of one user's cap: enough that
 * a handful of legitimate guests writing concurrently on a given day aren't
 * squeezed out by each other, small enough that guest abuse (the weakest
 * identity in the app) cannot approach the global cap on its own.
 */
const GUEST_GLOBAL_DAILY_CAP_USD = 5;

/**
 * The organisation-wide circuit breaker. An order-of-magnitude guess pending
 * real traffic, not a number derived from a specific budget — tune once one
 * exists.
 */
const GLOBAL_DAILY_CAP_USD = 100;

/**
 * `estimateCostUsd` returns `undefined` for a model `PRICING` doesn't
 * recognise (pricing.ts:44), deliberately never `0` — an honest "we don't
 * know," not a fabricated zero, because generation_event's job is to be
 * durable history and a silent zero would misreport it. Governance has a
 * different job: an unpriced generation must still count against the budget,
 * or the way to bypass it is to generate with an unpriced model. This is
 * therefore a *budget-enforcement* fallback, applied only to the Redis
 * counters below and never written back into generation_event itself, which
 * keeps the historical table's own "never fabricate a cost" rule intact.
 *
 * Sized conservatively: ~1,000 input tokens plus a full `MAX_OUTPUT_TOKENS`
 * (1,500) output at the priciest known tier (Sonnet 5, $2/$10 per MTok) is
 * ~$0.017; rounded up so this over-, never under-, counts an unpriced call.
 */
const UNPRICED_MODEL_FALLBACK_COST_USD = 0.02;

export type BudgetIdentity = { type: "user"; userId: string } | { type: "guest" };

export interface BudgetCheckResult {
  allowed: boolean;
  /** Absent when allowed. Which cap was hit, for the route to pick a message. */
  kind?: "user" | "guest" | "global";
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcDateSuffix(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Seconds from `now` to the next UTC midnight, plus a minute of margin. */
function secondsUntilNextUtcDay(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((next.getTime() - now.getTime()) / 1000) + 60;
}

function userKey(userId: string): string {
  return `budget:user:${userId}:${utcDateSuffix()}`;
}

/**
 * One key, not one per address. `clientIp` is spoofable and, absent a proxy
 * header, collapses to a single shared value anyway (see policy.ts) — a
 * per-guest budget would give an attacker who rotates addresses (or simply
 * has none to rotate, in the no-header case) a fresh $-budget on every
 * request. Sharing one budget across every guest is the honest bound on guest
 * cost abuse this identity actually supports; it does not, and cannot, stop
 * one guest from consuming the whole shared budget alone.
 */
function guestKey(): string {
  return `budget:guest:${utcDateSuffix()}`;
}

function globalKey(): string {
  return `budget:global:${utcDateSuffix()}`;
}

/**
 * Reads a Redis counter, reconciling from the Postgres source of truth on a
 * cold key (never written today, or evicted) before evaluating it against
 * `cap`. The Redis counters are an accelerator; `generation_event` is what
 * they're accelerating.
 */
async function readOrReconcile(
  key: string,
  reconcile: () => Promise<number>
): Promise<number | undefined> {
  return withKvTimeout(async () => {
    const kv = getKv();
    const existing = await kv.get<number>(key);
    if (existing !== null) return Number(existing);

    const total = await reconcile();
    // SET, not INCRBYFLOAT — this is a seed from the source of truth, and two
    // concurrent cold reads both seeding the same real total is idempotent,
    // unlike two concurrent increments of an already-correct value.
    await kv.set(key, total, { ex: secondsUntilNextUtcDay() });
    return total;
  });
}

/**
 * The organisation-wide cap. Fails **closed**: Redis being unavailable falls
 * back to a direct `generation_event` aggregate, because this is the one
 * check that stands between the app and an unbounded provider bill. Only if
 * *that* also fails does this allow the request — logged loudly, since a
 * double infrastructure failure denying every Writer is worse than a few
 * unbounded dollars for the short window until someone notices the log line.
 */
async function checkGlobalCap(db: AppDatabase): Promise<boolean> {
  if (hasKv()) {
    const spend = await readOrReconcile(globalKey(), () => sumGlobalCostSince(db, utcDayStart()));
    if (spend !== undefined) return spend < GLOBAL_DAILY_CAP_USD;
  }
  try {
    const spend = await sumGlobalCostSince(db, utcDayStart());
    return spend < GLOBAL_DAILY_CAP_USD;
  } catch (err) {
    console.error("[budget] global cap check failed against both Redis and Postgres, allowing:", err);
    return true;
  }
}

/**
 * The per-user (or shared guest) cap. Fails **open**: without Redis this skips
 * the check entirely rather than paying a Postgres round trip for a
 * per-caller concern the global cap above already backstops. Bounded spend
 * per account is a nice-to-have on top of the org-wide circuit breaker, not
 * itself the thing standing between the app and an unbounded bill.
 */
async function checkIdentityCap(db: AppDatabase, identity: BudgetIdentity): Promise<boolean> {
  if (!hasKv()) return true;

  const key = identity.type === "user" ? userKey(identity.userId) : guestKey();
  const cap = identity.type === "user" ? PER_USER_DAILY_CAP_USD : GUEST_GLOBAL_DAILY_CAP_USD;
  const reconcile =
    identity.type === "user"
      ? () => sumUserCostSince(db, identity.userId, utcDayStart())
      : () => sumGuestCostSince(db, utcDayStart());

  const spend = await readOrReconcile(key, reconcile);
  // Redis configured but unresponsive on this call — same fail-open reasoning
  // as the !hasKv() branch above, not a second fallback path to maintain.
  if (spend === undefined) return true;
  return spend < cap;
}

/**
 * Order matches the file's own fail-open/fail-closed asymmetry: the check
 * that must not be skipped runs first, so a global-cap denial never pays for
 * a per-identity Redis round trip it doesn't need.
 */
export async function checkBudget(db: AppDatabase, identity: BudgetIdentity): Promise<BudgetCheckResult> {
  if (!(await checkGlobalCap(db))) return { allowed: false, kind: "global" };
  if (!(await checkIdentityCap(db, identity))) return { allowed: false, kind: identity.type };
  return { allowed: true };
}

/**
 * Records what a completed generation actually cost against both the
 * identity's counter and the global counter. Best-effort against Redis
 * (`generation_event`, written by the caller alongside this, is the durable
 * record); a failure here only delays the next reconciliation, it never loses
 * the spend itself.
 */
export async function recordSpend(identity: BudgetIdentity, costUsd: number | undefined): Promise<void> {
  if (!hasKv()) return;

  let effectiveCost = costUsd;
  if (effectiveCost === undefined) {
    effectiveCost = UNPRICED_MODEL_FALLBACK_COST_USD;
    console.warn(
      `[budget] generation with no known price counted at the conservative default of $${UNPRICED_MODEL_FALLBACK_COST_USD}`
    );
  }

  const identityKey = identity.type === "user" ? userKey(identity.userId) : guestKey();
  const ttl = secondsUntilNextUtcDay();
  await withKvTimeout(async () => {
    const kv = getKv();
    await kv.incrbyfloat(identityKey, effectiveCost);
    await kv.expire(identityKey, ttl);
    await kv.incrbyfloat(globalKey(), effectiveCost);
    await kv.expire(globalKey(), ttl);
  });
}
