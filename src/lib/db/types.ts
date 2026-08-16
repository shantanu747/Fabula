import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type * as schema from "./schema";

/**
 * The app's database handle.
 *
 * Deliberately NOT the raw NeonHttpDatabase:
 *  - `transaction` is omitted because neon-http throws at runtime
 *    (neon-http/session.js:152). Tests run on node-postgres, which DOES support
 *    transactions — without this omission a green test could ship a 500.
 *  - `batch` is omitted for the mirror-image reason: it exists on neon-http and
 *    not on NodePgDatabase, so using it would make the route untestable.
 *
 * Enforced again by eslint.config.mjs and src/lib/db/driver-capabilities.test.ts.
 */
export type AppDatabase = Omit<NeonHttpDatabase<typeof schema>, "transaction" | "batch">;