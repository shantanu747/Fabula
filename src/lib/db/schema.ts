import {
  boolean,
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
  ]
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

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
});

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
});

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
  (t) => [unique().on(t.storyId, t.reporterId)]
);
