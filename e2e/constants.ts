/**
 * Shared between playwright.config.ts, global-setup.ts, global-teardown.ts, and
 * the helpers — one source of truth so the app's env, the mock provider's port,
 * and the database URLs can't drift apart between the places that reference them.
 */

export const APP_PORT = 3111;
export const BASE_URL = `http://localhost:${APP_PORT}`;

// Fixed, not ephemeral: playwright.config.ts's webServer.env is static and is
// read before global-setup.ts runs, so the app needs to know this port ahead of
// time rather than discovering it after the mock server picks one.
export const MOCK_PROVIDER_PORT = 51955;
export const MOCK_PROVIDER_URL = `http://127.0.0.1:${MOCK_PROVIDER_PORT}`;

export const E2E_DB_NAME = "fabula_e2e";

// The Neon HTTP proxy documented in README.md's "Developing against a local
// database" section, and required reading in docs/plans/v3/02-e2e-journeys.md —
// it's how the app's real @neondatabase/serverless driver can reach a plain
// Postgres. Overridable so CI can point at the service hostname instead of
// db.localtest.me (which is only meaningful with the loopback-resolving DNS
// trick this proxy image relies on for local dev).
export const NEON_PROXY_HOST = process.env.E2E_NEON_PROXY_HOST ?? "db.localtest.me:4444";
export const DATABASE_URL = `postgres://postgres:postgres@${NEON_PROXY_HOST}/${E2E_DB_NAME}`;
export const NEON_FETCH_ENDPOINT = `http://${NEON_PROXY_HOST}/sql`;
