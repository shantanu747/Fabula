import { defineConfig, devices } from "@playwright/test";
import {
  APP_PORT,
  BASE_URL,
  DATABASE_URL,
  KV_REST_API_TOKEN,
  KV_REST_API_URL,
  MOCK_PROVIDER_URL,
  NEON_FETCH_ENDPOINT,
} from "./constants";

const RESPONSIVE_SPEC = /responsive\.spec\.ts$/;
const ACCESSIBILITY_SPEC = /accessibility\.spec\.ts$/;
const VISUAL_SPEC = /visual\.spec\.ts$/;

// Visual regression (Plan 8) is deliberately not part of the default e2e run —
// it's slower (fifteen checkpoints × five projects, see visual.spec.ts) and a
// pixel-fidelity failure shouldn't block a behavioral fix while the design
// owner decides whether the new pixels are right. It stays in this same
// config (not a second one) but only runs when E2E_VISUAL=1 flips every
// viewport-gated project over to visual.spec.ts alone; the normal run never
// matches it, on any project.
const RUN_VISUAL_ONLY = process.env.E2E_VISUAL === "1";
const VIEWPORT_SPECS = RUN_VISUAL_ONLY ? [VISUAL_SPEC] : [RESPONSIVE_SPEC, ACCESSIBILITY_SPEC];
// The dark-scheme projects (added for accessibility's dark-mode axe scan)
// never run responsive.spec.ts — colour alone can't change layout/tap-target
// geometry, so re-running that spec here would just cost time for no signal.
const DARK_SPECS = RUN_VISUAL_ONLY ? [VISUAL_SPEC] : [ACCESSIBILITY_SPEC];
// "chromium" never runs the viewport-gated specs. During a visual-only run it
// runs nothing at all — without this, E2E_VISUAL=1 left it running the full
// journey-spec suite too (every spec matches by default when nothing narrows
// it), duplicating what the plain `e2e` job already covers and defeating the
// point of a separate, lean visual job.
const CHROMIUM_IGNORE = RUN_VISUAL_ONLY ? [/\.spec\.ts$/] : [RESPONSIVE_SPEC, ACCESSIBILITY_SPEC, VISUAL_SPEC];

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
    // test) and `npm run test:e2e:soak` for re-verifying it. This headroom
    // is unrelated to the guest-write.spec.ts flake ADR 0020/0021 also
    // chased — that turned out (ADR 0026, after two wrong theories) to be a
    // React-paint-timing assertion needing real margin on the mock's own
    // delayMs, not a budget this timeout could paper over.
    timeout: process.env.CI ? 15_000 : 5_000,
    // visual.spec.ts's toHaveScreenshot budget. Not zero: font hinting and
    // subpixel rendering differ enough between macOS and CI's ubuntu-latest
    // runner that a pixel-identical comparison isn't meaningful across
    // platforms — snapshots are generated on CI itself (see e2e/README.md)
    // specifically so this only has to absorb anti-aliasing noise, not a
    // whole-platform rendering difference. 0.01 is a starting point; widen it
    // only if the "run it twice with no changes" check before shipping the
    // job shows real self-flakiness at this value.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // Absorbed from the deleted scripts/responsive-check.mjs (Plan 6) — that
    // script's full-page screenshots were the useful half of it, kept here as
    // a failure artifact rather than something every spec generates.
    screenshot: "only-on-failure",
  },

  // The journey specs run once, at a single desktop viewport, under
  // "chromium". responsive.spec.ts, accessibility.spec.ts and visual.spec.ts
  // are the specs that need to run at every viewport (Plans 6 and 8) —
  // testMatch/testIgnore split them apart so nothing runs more than once per
  // project. mobile-dark/desktop-dark (Plan 8) re-run the axe scan and the
  // visual snapshots under colorScheme: "dark" — light-only projects never
  // need a dark pass, and dark-only projects never need responsive's.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: CHROMIUM_IGNORE },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
      testMatch: VIEWPORT_SPECS,
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
      testMatch: VIEWPORT_SPECS,
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testMatch: VIEWPORT_SPECS,
    },
    {
      name: "mobile-dark",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, colorScheme: "dark" },
      testMatch: DARK_SPECS,
    },
    {
      name: "desktop-dark",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      testMatch: DARK_SPECS,
    },
  ],

  webServer: {
    command: `npm run build && npm run start -- -p ${APP_PORT}`,
    url: BASE_URL,
    // next build is slow; reuse a server already running locally between
    // iterations, but always start fresh in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: "..",
    env: {
      // All three point at the same mock (docs/adr/0019's "the seam is the
      // provider's base URL" applies uniformly) — Plan 4's provider-failover
      // tests are the first to actually need a second provider to succeed
      // through the mock rather than just fail, which surfaced that only
      // ANTHROPIC_BASE_URL had ever been wired here.
      ANTHROPIC_BASE_URL: MOCK_PROVIDER_URL,
      OPENAI_BASE_URL: MOCK_PROVIDER_URL,
      OPENROUTER_BASE_URL: MOCK_PROVIDER_URL,
      // The SDK requires a non-empty string even when the base URL is local.
      ANTHROPIC_API_KEY: "e2e-key",
      OPENAI_API_KEY: "e2e-key",
      OPENROUTER_API_KEY: "e2e-key",
      DATABASE_URL,
      NEON_FETCH_ENDPOINT,
      KV_REST_API_URL,
      KV_REST_API_TOKEN,
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
