import { sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/lib/db/client";
import { guardHealth } from "@/lib/ratelimit/guard";
import { PROVIDERS } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

const startedAt = Date.now();

/** Provider id -> the env var its adapter reads its API key from. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const DATABASE_CHECK_TIMEOUT_MS = 2000;

type DatabaseStatus = "ok" | "unreachable" | "not-configured";

async function checkDatabase(): Promise<DatabaseStatus> {
  // Not configured is a valid deployment, not a failure — guest writing works
  // without a database by design (docs/adr/0009), and a health endpoint that
  // treated "no DATABASE_URL" as unhealthy would contradict that on every
  // "clone it and try the guest flow" environment.
  if (!hasDatabase()) return "not-configured";

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), DATABASE_CHECK_TIMEOUT_MS)
  );

  try {
    // hasDatabase() can be true from an injected test handle alone (see its own
    // doc comment) — this SELECT 1 is what actually proves the database is
    // reachable, rather than trusting that flag.
    const result = await Promise.race([getDb().execute(sql`select 1`), timeout]);
    return result === "timeout" ? "unreachable" : "ok";
  } catch {
    return "unreachable";
  }
}

function checkProviders(): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  for (const id of Object.keys(PROVIDERS)) {
    const envVar = PROVIDER_KEY_ENV[id];
    // Boolean key-presence only — never the key itself, its prefix, or its
    // length, even for an id this map doesn't recognise.
    status[id] = Boolean(envVar && process.env[envVar]);
  }
  return status;
}

export async function GET(request: Request) {
  const limited = await guardHealth(request);
  if (limited) return limited;

  const database = await checkDatabase();
  const providers = checkProviders();

  const status = database === "unreachable" ? "degraded" : "ok";

  return Response.json(
    {
      status,
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks: { database, providers },
    },
    { status: status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
