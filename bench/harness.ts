/**
 * `npm run bench` — a scripted multi-writer capacity benchmark against a
 * locally built app, a real Postgres behind the Neon HTTP proxy, and the
 * mock provider. See docs/plans/v4/01-load-harness.md and docs/adr/0034.
 *
 * This measures. It does not add k6/artillery (separate binaries that can't
 * drive the mock provider's remote-control plane or read generation_event
 * back) and it is not a CI job (see the ADR for why).
 */
import { parseArgs } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { startMockProvider } from "../test-support/mock-provider/server";
import { streamResponse } from "../e2e/helpers/mock";
import { resetDatabase } from "../e2e/helpers/db";
import {
  DATABASE_URL,
  E2E_DB_NAME,
  MOCK_PROVIDER_PORT,
  NEON_FETCH_ENDPOINT,
} from "../e2e/constants";
import { TEST_DB_BASE_URL } from "../src/test/db-names";
import {
  formatTable,
  summarize,
  toJson,
  type CostSummary,
  type RoundtripCount,
  type RunMetrics,
  type TurnSample,
} from "./report";
import { mkdir, writeFile } from "node:fs/promises";

// Deliberately not e2e's APP_PORT (3111): that port is reserved for Playwright's
// webServer (see this repo's own "never dev on 3111" lesson), and the bench app
// and an e2e run must never be mistaken for each other if both happen to be live.
const BENCH_APP_PORT = 3112;
const BASE_URL = `http://localhost:${BENCH_APP_PORT}`;

interface Args {
  writers: number;
  turns: number;
  rampMs: number;
  chunkDelayMs: number;
  live: boolean;
  confirmLiveSpend: boolean;
  skipBuild: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      writers: { type: "string", default: "10" },
      turns: { type: "string", default: "10" },
      "ramp-ms": { type: "string" },
      "chunk-delay-ms": { type: "string", default: "15" },
      live: { type: "boolean", default: false },
      "confirm-live-spend": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
    },
  });
  const writers = Number(values.writers);
  const turns = Number(values.turns);
  const rampMs = values["ramp-ms"] !== undefined ? Number(values["ramp-ms"]) : writers * 200;
  const chunkDelayMs = Number(values["chunk-delay-ms"]);

  if (values.live && !values["confirm-live-spend"]) {
    throw new Error(
      "--live spends real provider money. Re-run with --live --confirm-live-spend to proceed."
    );
  }

  return {
    writers,
    turns,
    rampMs,
    chunkDelayMs,
    live: Boolean(values.live),
    confirmLiveSpend: Boolean(values["confirm-live-spend"]),
    skipBuild: Boolean(values["skip-build"]),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: `${TEST_DB_BASE_URL}/postgres` });
  try {
    await admin.query("SELECT 1");
  } catch (err) {
    await admin.end().catch(() => {});
    throw new Error(
      `bench/harness: cannot reach Postgres at ${TEST_DB_BASE_URL}. Start one with:\n\n` +
        `  docker run -d --name fabula-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \\\n` +
        `    -p 5432:5432 postgres:17-alpine\n\nOriginal error: ${(err as Error).message}`
    );
  }

  // Same "WITH (FORCE)" reasoning as e2e/global-setup.ts and src/test/global-setup-db.ts:
  // a previous crashed run can leave a connection attached. Duplicated here rather
  // than importing e2e/global-setup.ts's version: that file is load-bearing for the
  // CI e2e job and owns a Playwright-specific lifecycle (globalThis handoff to
  // global-teardown.ts); this harness has its own, simpler lifecycle (one process,
  // no separate teardown phase) and duplicating ~15 lines here is lower risk than
  // threading a load test's setup through e2e's.
  await admin.query(`DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${E2E_DB_NAME}"`);
  await admin.end();

  const appPool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${E2E_DB_NAME}` });
  await migrate(drizzle({ client: appPool }), { migrationsFolder: "./src/lib/db/migrations" });
  // The Neon proxy's own bootstrapping table — see e2e/global-setup.ts's identical
  // step for why this isn't a Drizzle migration.
  await appPool.query(`CREATE SCHEMA IF NOT EXISTS neon_control_plane`);
  await appPool.query(
    `CREATE TABLE IF NOT EXISTS neon_control_plane.endpoints (endpoint_id VARCHAR(255) PRIMARY KEY, allowed_ips VARCHAR(255))`
  );
  await appPool.end();
}

async function verifyNeonProxyReachable(): Promise<void> {
  try {
    await fetch(NEON_FETCH_ENDPOINT, { method: "POST", body: "{}" });
  } catch (err) {
    throw new Error(
      `bench/harness: cannot reach the Neon HTTP proxy at ${NEON_FETCH_ENDPOINT}. Start it with:\n\n` +
        `  docker run -d --name fabula-e2e-neon-proxy -p 4444:4444 \\\n` +
        `    -e PG_CONNECTION_STRING="postgres://postgres:postgres@host.docker.internal:5432/${E2E_DB_NAME}" \\\n` +
        `    ghcr.io/timowilhelm/local-neon-http-proxy:main\n\nOriginal error: ${(err as Error).message}`
    );
  }
}

function runToCompletion(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: process.cwd() });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function spawnApp(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn("npm", ["run", "start", "--", "-p", String(BENCH_APP_PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`bench/harness: app never became reachable at ${url} within ${timeoutMs}ms`);
}

/** Minimal cookie jar — enough to carry an Auth.js JWT session cookie across
 *  the csrf -> credentials-callback -> authenticated-request sequence. */
class CookieJar {
  private cookies = new Map<string, string>();

  absorb(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * Registers, then signs in through Auth.js v5's Credentials provider over
 * plain HTTP (no browser) — the csrf token and the callback endpoint are the
 * same two requests next-auth's own client-side signIn() makes, replayed by
 * hand. All N virtual writers below share this ONE identity deliberately: see
 * docs/adr/0034 for why that's what makes the harness's default
 * --writers 10 --turns 10 actually exercise GENERATE_USER's rate limit
 * (capacity 20) rather than sailing under it.
 */
async function registerAndSignIn(baseUrl: string, email: string, password: string): Promise<{ cookie: string; userLabel: string }> {
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bench Writer", email, password }),
  });
  if (!registerRes.ok) {
    throw new Error(`bench/harness: registration failed (${registerRes.status})`);
  }

  const jar = new CookieJar();
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const body = new URLSearchParams({
    email,
    password,
    csrfToken,
    callbackUrl: baseUrl,
    json: "true",
  });
  const callbackRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.absorb(callbackRes);
  const cookie = jar.header();
  if (!/session-token=/.test(cookie)) {
    throw new Error(
      `bench/harness: sign-in did not yield a session cookie (status ${callbackRes.status}). ` +
        `Cookie jar so far: ${cookie || "(empty)"}`
    );
  }
  return { cookie, userLabel: email };
}

interface StoryParagraph {
  author: "writer" | "ai";
  text: string;
  providerId?: string;
}

async function createStory(baseUrl: string, cookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/stories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ theme: "Benchmark", targetLength: 30, selectedProviderId: "anthropic" }),
  });
  if (!res.ok) throw new Error(`bench/harness: story creation failed (${res.status})`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

interface GenerateOutcome {
  status: number;
  ttftMs?: number;
  totalMs: number;
  aiText: string;
  storySoFarBytes: number;
}

async function timedGenerate(
  baseUrl: string,
  cookie: string,
  storyId: string,
  storySoFar: StoryParagraph[]
): Promise<GenerateOutcome> {
  const payload = JSON.stringify({ providerId: "anthropic", storySoFar, storyId, targetLength: 30, theme: "Benchmark" });
  const storySoFarBytes = Buffer.byteLength(JSON.stringify(storySoFar));
  const start = performance.now();
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: payload,
  });

  if (res.status !== 200 || !res.body) {
    await res.arrayBuffer().catch(() => undefined); // drain
    return { status: res.status, totalMs: performance.now() - start, aiText: "", storySoFarBytes };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttftMs: number | undefined;
  let aiText = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttftMs === undefined) ttftMs = performance.now() - start;
    aiText += decoder.decode(value, { stream: true });
  }
  return { status: res.status, ttftMs, totalMs: performance.now() - start, aiText, storySoFarBytes };
}

function writerParagraph(turn: number): StoryParagraph {
  return { author: "writer", text: `Bench writer turn ${turn}: the story continues, deliberately unremarkable prose.` };
}

/** Phase A: sequential, one call at a time, so the round-trip counter (reset
 *  before each call, read after) attributes a clean count to exactly one
 *  /api/generate call. Never run concurrently with anything else that touches
 *  the shared /api/__bench/roundtrips counter. */
async function measureRoundtrips(baseUrl: string, cookie: string): Promise<RoundtripCount[]> {
  const storyId = await createStory(baseUrl, cookie);
  const results: RoundtripCount[] = [];
  let storySoFar: StoryParagraph[] = [];

  // Drain/reset whatever accumulated during setup (registration, sign-in, story
  // creation) before the first measured turn.
  await fetch(`${baseUrl}/api/__bench/roundtrips`);

  for (let turn = 0; turn < 3; turn++) {
    if (turn > 0) storySoFar = [...storySoFar, writerParagraph(turn)];
    const outcome = await timedGenerate(baseUrl, cookie, storyId, storySoFar);
    if (outcome.status === 200) storySoFar = [...storySoFar, { author: "ai", text: outcome.aiText }];

    const countsRes = await fetch(`${baseUrl}/api/__bench/roundtrips`);
    const counts = (await countsRes.json()) as { select: number; insert: number; update: number; execute: number; total: number };
    results.push({ label: `saved-story turn ${turn} (status ${outcome.status})`, ...counts });
  }
  return results;
}

interface WriterResult {
  samples: TurnSample[];
}

async function runWriter(
  baseUrl: string,
  cookie: string,
  writerId: number,
  turns: number,
  storyId: string
): Promise<WriterResult> {
  const samples: TurnSample[] = [];
  let storySoFar: StoryParagraph[] = [];

  for (let turn = 0; turn < turns; turn++) {
    if (turn > 0) storySoFar = [...storySoFar, writerParagraph(turn)];
    const outcome = await timedGenerate(baseUrl, cookie, storyId, storySoFar);
    samples.push({
      writerId,
      turn,
      ttftMs: outcome.ttftMs,
      totalMs: outcome.totalMs,
      status: outcome.status,
      storySoFarBytes: outcome.storySoFarBytes,
    });
    if (outcome.status === 200) {
      storySoFar = [...storySoFar, { author: "ai", text: outcome.aiText }];
    } else {
      // A rejected turn (429/502/409/499) can't append an AI paragraph — the
      // next iteration's storySoFar still ends in "writer" (or stays empty),
      // which is exactly what isAIsTurn() requires for the retry to be valid.
    }
  }
  return { samples };
}

async function runConcurrentWorkload(
  baseUrl: string,
  cookie: string,
  writers: number,
  turns: number,
  rampMs: number
): Promise<{ samples: TurnSample[]; wallMs: number }> {
  const storyIds = await Promise.all(Array.from({ length: writers }, () => createStory(baseUrl, cookie)));

  const wallStart = performance.now();
  const runs = storyIds.map(async (storyId, i) => {
    const delay = Math.round((i / Math.max(writers, 1)) * rampMs);
    if (delay > 0) await sleep(delay);
    return runWriter(baseUrl, cookie, i, turns, storyId);
  });
  const results = await Promise.all(runs);
  const wallMs = performance.now() - wallStart;

  return { samples: results.flatMap((r) => r.samples), wallMs };
}

async function readCostSummary(userId: string): Promise<CostSummary> {
  const pool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${E2E_DB_NAME}` });
  try {
    const { rows } = await pool.query<{
      events: number;
      inputtokens: number;
      outputtokens: number;
      costusd: number;
    }>(
      `select count(*)::int as events,
              coalesce(sum("inputTokens"), 0)::int as inputtokens,
              coalesce(sum("outputTokens"), 0)::int as outputtokens,
              coalesce(sum("costUsd"), 0)::float as costusd
         from "generation_event"
        where "userId" = $1`,
      [userId]
    );
    const row = rows[0];
    return {
      stories: 0, // filled in by the caller, which knows how many it created
      events: row.events,
      inputTokens: row.inputtokens,
      outputTokens: row.outputtokens,
      costUsd: row.costusd,
    };
  } finally {
    await pool.end();
  }
}

async function lookUpUserId(email: string): Promise<string> {
  const pool = new Pool({ connectionString: `${TEST_DB_BASE_URL}/${E2E_DB_NAME}` });
  try {
    const { rows } = await pool.query<{ id: string }>(`select id from "user" where email = $1`, [email]);
    if (rows.length === 0) throw new Error(`bench/harness: could not find the writer account it just created (${email})`);
    return rows[0].id;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.live) {
    console.log(
      "!!! --live: this run calls real providers with real API keys and spends real money. !!!"
    );
  } else {
    console.log("Using the mock provider (default). Pass --live --confirm-live-spend to spend real money.");
  }

  console.log("Checking local Postgres and Neon HTTP proxy...");
  await ensureDatabase();
  await verifyNeonProxyReachable();
  await resetDatabase();

  console.log(`Starting mock provider on port ${MOCK_PROVIDER_PORT} (chunk delay ${args.chunkDelayMs}ms)...`);
  const mock = args.live ? undefined : await startMockProvider({ port: MOCK_PROVIDER_PORT });
  if (mock) {
    const chunks = ["The ", "story ", "continues ", "in ", "a ", "way ", "nobody ", "expected."];
    mock.setScript(() => streamResponse(chunks, { delayMs: args.chunkDelayMs }));
  }

  const appEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL,
    NEON_FETCH_ENDPOINT,
    AUTH_SECRET: "bench-fixed-secret-do-not-use-in-prod",
    AUTH_URL: BASE_URL,
    NEXTAUTH_URL: BASE_URL,
    AUTH_TRUST_HOST: "true",
    BENCH_INSTRUMENTATION: "1",
    ...(args.live
      ? {}
      : {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PROVIDER_PORT}`,
          OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PROVIDER_PORT}`,
          OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PROVIDER_PORT}`,
          ANTHROPIC_API_KEY: "bench-key",
          OPENAI_API_KEY: "bench-key",
          OPENROUTER_API_KEY: "bench-key",
        }),
  };

  if (!args.skipBuild) {
    console.log("next build (never next dev — dev-mode compilation would dominate the measurement)...");
    await runToCompletion("npm", ["run", "build"]);
  }

  console.log(`Starting the app on ${BASE_URL}...`);
  const app = spawnApp(appEnv);
  let appOutput = "";
  app.stdout?.on("data", (chunk: Buffer) => (appOutput += chunk.toString()));
  app.stderr?.on("data", (chunk: Buffer) => (appOutput += chunk.toString()));

  try {
    await waitForServer(BASE_URL, 60_000);

    const email = `bench-writer-${Date.now()}@fabula.bench`;
    const password = "bench-password-not-real";
    console.log(`Signing in as the shared writer identity (${email})...`);
    const { cookie } = await registerAndSignIn(BASE_URL, email, password);
    const userId = await lookUpUserId(email);

    console.log("Phase A: DB round trips per operation (sequential, one call at a time)...");
    const roundTrips = await measureRoundtrips(BASE_URL, cookie);

    console.log(
      `Phase B: concurrency workload — ${args.writers} writers x ${args.turns} turns, ` +
        `ramped over ${args.rampMs}ms...`
    );
    const { samples, wallMs } = await runConcurrentWorkload(BASE_URL, cookie, args.writers, args.turns, args.rampMs);

    const cost = await readCostSummary(userId);
    cost.stories = args.writers + 1; // +1 for Phase A's story

    const metrics: RunMetrics = {
      writers: args.writers,
      turns: args.turns,
      rampMs: args.rampMs,
      mockChunkDelayMs: args.chunkDelayMs,
      identity: "shared-authenticated",
      wallMs,
      samples,
      roundTrips,
      cost,
    };
    const summary = summarize(metrics);

    console.log("");
    console.log(formatTable(metrics, summary));

    await mkdir("bench/results", { recursive: true });
    const outPath = `bench/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await writeFile(outPath, toJson(metrics, summary));
    console.log(`\nJSON written to ${outPath}`);
  } catch (err) {
    console.error("bench/harness: run failed. Recent app output:\n" + appOutput.slice(-4000));
    throw err;
  } finally {
    app.kill();
    await mock?.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
