import { defineConfig, devices } from "@playwright/test";
import {
  APP_PORT,
  BASE_URL,
  DATABASE_URL,
  MOCK_PROVIDER_URL,
  NEON_FETCH_ENDPOINT,
} from "./constants";

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",

  // The specs share one database and one mock server, and rate-limit.spec.ts
  // deliberately exhausts a global bucket — see helpers/db.ts's resetDatabase()
  // for how isolation between specs is actually maintained instead. Revisit
  // only if a worker-scoped database is added later.
  fullyParallel: false,
  workers: 1,

  retries: process.env.CI ? 1 : 0,

  expect: {
    // Default is 5s. Every assertion here can sit behind a real network
    // round trip: guardGenerate's rate-limit check alone is a DB write
    // through the local Neon HTTP proxy (ADR 0009), before the mock
    // provider or its streamed chunks ever enter the picture. A dev
    // machine absorbs that easily; GitHub's shared ubuntu-latest runners
    // (2 vCPU) don't always. See ADR 0020 for how this was diagnosed
    // (and what it isn't — a connection-pool race, ruled out by soak
    // test) and `npm run test:e2e:soak` for re-verifying it.
    timeout: process.env.CI ? 15_000 : 5_000,
  },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: `npm run build && npm run start -- -p ${APP_PORT}`,
    url: BASE_URL,
    // next build is slow; reuse a server already running locally between
    // iterations, but always start fresh in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: "..",
    // TEMPORARY, alongside the [generate:timing] console.log lines in
    // src/app/api/generate/route.ts (see ADR 0021): webServer only pipes
    // stderr by default, which is why every [WebServer] line seen in CI so
    // far has been a console.error — both those diagnostics and the app's own
    // structured logger (src/lib/observability/logger.ts) use console.log for
    // info/warn levels, and would otherwise be silently dropped from CI's
    // output. Remove this once the timing diagnostics above are removed.
    stdout: "pipe",
    env: {
      ANTHROPIC_BASE_URL: MOCK_PROVIDER_URL,
      // The SDK requires a non-empty string even when the base URL is local.
      ANTHROPIC_API_KEY: "e2e-key",
      OPENAI_API_KEY: "e2e-key",
      OPENROUTER_API_KEY: "e2e-key",
      DATABASE_URL,
      NEON_FETCH_ENDPOINT,
      AUTH_SECRET: "e2e-fixed-test-secret-do-not-use-in-prod",
      AUTH_URL: BASE_URL,
      NEXTAUTH_URL: BASE_URL,
      // Auth.js refuses to serve requests whose Host it doesn't recognize as
      // trusted in production, unless told to trust it explicitly — Vercel
      // deployments get this for free, plain `next start` over HTTP does not.
      AUTH_TRUST_HOST: "true",
    },
  },
});
