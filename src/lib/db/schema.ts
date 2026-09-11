import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// Auth.js's standard Drizzle/Postgres adapter schema (authjs.dev/reference/adapter/drizzle),
// extended with `passwordHash` for the Credentials (email/password) provider — null for
// Google-only accounts. Column names/shapes below must match what `@auth/drizzle-adapter`'s
// `PostgresDrizzleAdapter` expects; see node_modules/@auth/drizzle-adapter/lib/pg.d.ts.

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  passwordHash: text("passwordHash"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
    index().on(account.userId),
  ]
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
}, (t) => [
  index().on(t.userId),
]);

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })]
);

// App-specific tables — a persisted mirror of the client-side StoryState/StoryParagraph
// shapes (src/lib/story/types.ts), written to as a side effect of /api/generate for
// logged-in Writers only. See docs/adr/0009-accounts-and-persistence-architecture.md.

export const stories = pgTable("story", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  ownerId: text("ownerId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme"),
  characters: text("characters"),
  openingLines: text("openingLines"),
  targetLength: integer("targetLength").notNull(),
  selectedProviderId: text("selectedProviderId").notNull(),
  invented: jsonb("invented").$type<{ theme?: string; characters?: string }>(),
  isShared: boolean("isShared").notNull().default(false),
  // Denormalized mirrors of story_paragraph, maintained in the same statements
  // that write paragraphs (docs/adr/0041). Let the sync-prefix check in
  // src/lib/db/paragraphs.ts skip reading every paragraph row on the common
  // case, and let the feed/library queries drop their count-by-groupBy join.
  // contentHash is nullable because rows written before this migration have
  // none until their next write; paragraphCount defaults to 0 for the same
  // pre-existing rows (all of which have zero paragraphs backfilled anyway).
  paragraphCount: integer("paragraphCount").notNull().default(0),
  contentHash: text("contentHash"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
}, (t) => [
  // Widened from (ownerId, updatedAt DESC) to add "id" as a tiebreaker
  // (docs/adr/0041): keyset pagination's WHERE (updatedAt, id) < (cursor)
  // needs a second, unique column in the ORDER BY / index whenever two
  // stories share the same updatedAt, or a page boundary can skip or repeat a
  // row. Still written as raw SQL, not t.updatedAt.desc()/t.id.desc(), for the
  // same "DESC NULLS LAST" vs. plain "DESC" (NULLS FIRST) mismatch ADR 0017
  // found — both columns are NOT NULL, so this changes nothing semantically,
  // only whether the index can supply the sort. Verified in queries.perf.test.ts.
  index("story_ownerId_updatedAt_id_index").on(t.ownerId, sql`"updatedAt" DESC`, sql`"id" DESC`),
  // The predicate must be `sql`, not the bare column — drizzle-kit calls .toQuery()
  // on whatever it's given while serializing the snapshot, so passing t.isShared
  // makes `drizzle-kit generate` throw before writing anything. Written unqualified
  // because Postgres rejects table-qualified names in an index predicate. Same
  // "id" tiebreaker addition as above, for the feed's keyset pagination.
  index("stories_updated_at_id_is_shared_idx")
    .on(sql`"updatedAt" DESC`, sql`"id" DESC`)
    .where(sql`"isShared" = true`)
]);

export const storyParagraphs = pgTable("story_paragraph", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  storyId: text("storyId")
    .notNull()
    .references(() => stories.id, { onDelete: "cascade" }),
  authorType: text("authorType").$type<"writer" | "ai">().notNull(),
  text: text("text").notNull(),
  providerId: text("providerId"),
  position: integer("position").notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
}, (t) => [unique().on(t.storyId, t.position)]);

export const storyReports = pgTable(
  "story_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    storyId: text("storyId")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    reporterId: text("reporterId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.storyId, t.reporterId),
    index().on(t.reporterId)
  ]
);

/**
 * Token buckets for rate limiting (docs/adr/0015).
 *
 * The state lives in Postgres rather than in module scope because the app runs
 * on serverless functions: every invocation may be a fresh isolate, so an
 * in-memory counter limits one instance rather than one caller, and resets
 * whenever the platform recycles it. There is no separate Redis here — the
 * database is already a dependency of every request this protects.
 *
 * Keyed by a caller identity string (see src/lib/ratelimit/policy.ts), which is
 * the primary key, so a bucket read is a single index lookup and needs no
 * further index.
 */
export const rateLimitBuckets = pgTable("rate_limit_bucket", {
  key: text("key").primaryKey(),
  /** Fractional, because refill is continuous rather than per-tick. */
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

/**
 * Durable, SQL-queryable per-generation cost/token history (docs/adr/0022). One
 * row per /api/generate call, written best-effort alongside the OTel span — the
 * span is the source of truth for tracing, this table is for questions a
 * sampled/expiring trace backend can't answer, like "what did user X cost last
 * month".
 *
 * Deliberately `onDelete: "set null"` on userId/storyId, unlike every other
 * table's `cascade` above: this table's whole purpose is durable history, and a
 * deleted account or story shouldn't erase what it already cost. Both are
 * nullable for the same reason every other field here is best-effort — guests
 * (no userId) and unsaved stories (no storyId) still generate and still cost
 * money.
 */
export const generationEvents = pgTable(
  "generation_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    requestId: text("requestId").notNull(),
    providerId: text("providerId").notNull(),
    model: text("model").notNull(),
    userId: text("userId").references(() => users.id, { onDelete: "set null" }),
    storyId: text("storyId").references(() => stories.id, { onDelete: "set null" }),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    // Prompt-cache observability (docs/adr/0040). Nullable like every other
    // usage field here: absent means the provider/model didn't report it,
    // never fabricated as 0 (docs/adr/0022).
    cacheReadInputTokens: integer("cacheReadInputTokens"),
    cacheCreationInputTokens: integer("cacheCreationInputTokens"),
    costUsd: doublePrecision("costUsd"),
    ttftMs: integer("ttftMs"),
    totalMs: integer("totalMs"),
    outcome: text("outcome")
      .$type<"success" | "provider_error" | "cancelled" | "persist_failed">()
      .notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Composite, not the single-column userId index this replaces
    // (docs/adr/0036): the budget module's per-user reconciliation query is
    // `WHERE userId = $1 AND createdAt >= $2`, a range on the second column,
    // which a userId-only index cannot serve without a further sort/filter
    // step. DESC written as raw SQL rather than t.createdAt.desc() for the
    // same NULLS LAST/NULLS FIRST mismatch reason as
    // story_ownerId_updatedAt_index above — createdAt is NOT NULL, so this
    // changes nothing semantically, only whether the index is usable.
    index("generation_event_userId_createdAt_index").on(t.userId, sql`"createdAt" DESC`),
    // Kept for the global (no userId filter) reconciliation query.
    index().on(t.createdAt),
    // storyId is a foreign key Postgres never indexes automatically
    // (docs/adr/0017's finding, recurring here) — read whenever a story's own
    // generation history is looked up. Unlike story_report's reporterId index,
    // this one is genuinely missing: story_report's existing
    // unique(storyId, reporterId) already covers storyId as its leading
    // column, so it needs no separate index (docs/adr/0041).
    index().on(t.storyId),
  ]
);
