import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { errorAlert, startStory } from "../helpers/story";

// ADR 0015 — Postgres-backed rate limiting.
//
// This spec deliberately exhausts the GENERATE_GUEST bucket for the loopback
// address (every guest request in this suite shares one identity — see
// src/lib/ratelimit/policy.ts's clientIp(), which falls back to "unknown" with
// no proxy headers in front of Playwright). It does not need to run last: every
// spec's beforeEach truncates rate_limit_bucket (see helpers/db.ts), which is
// what actually keeps this from leaking into other specs, regardless of order.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("a guest is rate-limited past GENERATE_GUEST's capacity, and the UI shows it with no Try again", async ({
  page,
  request,
}) => {
  await setMockScript(streamResponse(["A paragraph, generated."]));

  const body = { providerId: "anthropic", storySoFar: [] };
  for (let i = 0; i < 5; i++) {
    const response = await request.post("/api/generate", { data: body });
    expect(response.status()).toBe(200);
  }

  const limited = await request.post("/api/generate", { data: body });
  expect(limited.status()).toBe(429);
  const retryAfter = Number(limited.headers()["retry-after"]);
  expect(retryAfter).toBeGreaterThanOrEqual(1);

  // Reproduce the same 429 through the UI, purely to assert its rendering —
  // the bucket is already exhausted by the calls above.
  await startStory(page);
  const alert = errorAlert(page);
  await expect(alert).toContainText("Too many stories from this connection");
  await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
