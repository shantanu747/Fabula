import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";

// src/lib/db/driver-capabilities.test.ts
describe("neon-http driver capabilities", () => {
  it("neon-http rejects db.transaction() without contacting the database", async () => {
    const db = drizzle({ client: neon("postgres://u:p@example.invalid/db"), schema });
    await expect(db.transaction(async () => {})).rejects.toThrow(
      "No transactions support in neon-http driver"
    );
  });
});