import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Constructed lazily, not at module scope — the Neon driver throws immediately if
// DATABASE_URL isn't set, which would otherwise break `next build`/`next dev` startup
// before a developer has provisioned a database (mirrors the lazy provider-client
// pattern in src/lib/providers/anthropic.ts's getClient()).
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!db) {
    const sql = neon(process.env.DATABASE_URL!);
    db = drizzle({ client: sql, schema });
  }
  return db;
}
