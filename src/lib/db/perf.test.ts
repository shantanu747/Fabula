import { describe, expect, it } from "vitest";

// Performance/explain suite - referenced by nothing; run only via `npm run test:perf`
// Skipping for now due to database connection requirements
describe.skip("performance tests", () => {
  it("story paragraph query uses index", () => {
    // This test would normally run against a seeded database with 10k stories × 20 paragraphs
    // For now, this is just a placeholder
    expect(true).toBe(true);
  });
});