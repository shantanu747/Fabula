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
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
}, (t) => [
  // Written as raw SQL rather than t.updatedAt.desc(), which emits
  // "DESC NULLS LAST". A plain ORDER BY ... DESC means NULLS FIRST, so the two
  // orderings do not match and Postgres cannot take the sort from the index: the
  // library query bitmap-scans every one of a Writer's stories and sorts them,
  // instead of reading twenty rows off the index and stopping. The column is NOT
  // NULL, so this changes nothing semantically — only whether the index is
  // usable for ordering. Verified in src/lib/db/queries.perf.test.ts.
  index("story_ownerId_updatedAt_index").on(t.ownerId, sql`"updatedAt" DESC`),
  // The predicate must be `sql`, not the bare column — drizzle-kit calls .toQuery()
  // on whatever it's given while serializing the snapshot, so passing t.isShared
  // makes `drizzle-kit generate` throw before writing anything. Written unqualified
  // because Postgres rejects table-qualified names in an index predicate.
  index("stories_updated_at_is_shared_idx").on(t.updatedAt).where(sql`"isShared" = true`)
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
