/**
 * Shared between the global setup (which builds the template) and the per-file
 * setup (which clones it), so the two can't drift apart on a name.
 */
export const TEST_DB_BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432";

export const TEMPLATE_DB_NAME = "fabula_test_template";

/**
 * One database per Vitest worker. Workers run test files in parallel, and they
 * share nothing — so isolating on a TRUNCATE alone would let two files clear
 * each other's rows mid-test.
 */
export function workerDbName(): string {
  return `fabula_test_${process.env.VITEST_POOL_ID ?? "1"}`;
}
