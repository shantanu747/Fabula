import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { resetMockScript, setMockScript, streamResponse } from "../helpers/mock";
import { errorAlert, startStory } from "../helpers/story";
import { BASE_URL } from "../constants";

// Explicit on every direct request.post below — APIRequestContext doesn't
// add an Origin the way a real browser fetch() does, and assertSameOrigin
// (docs/adr/0048) requires one.
const SAME_ORIGIN = { Origin: BASE_URL };

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

test("a guest is rate-limited past GENERATE_GUEST's capacity, and the UI shows a live countdown, not a plain Try again", async ({
  page,
  request,
}) => {
  await setMockScript(streamResponse(["A paragraph, generated."]));

  const body = { providerId: "anthropic", storySoFar: [] };
  for (let i = 0; i < 5; i++) {
    const response = await request.post("/api/generate", { headers: SAME_ORIGIN, data: body });
    expect(response.status()).toBe(200);
  }

  const limited = await request.post("/api/generate", { headers: SAME_ORIGIN, data: body });
  expect(limited.status()).toBe(429);
  const retryAfter = Number(limited.headers()["retry-after"]);
  expect(retryAfter).toBeGreaterThanOrEqual(1);

  // Reproduce the same 429 through the UI, purely to assert its rendering —
  // the bucket is already exhausted by the calls above.
  await startStory(page);
  const alert = errorAlert(page);
  await expect(alert).toContainText("Too many stories from this connection");

  // A live countdown from the server's own Retry-After
  // (docs/adr/0044-durable-writer-turns-and-idempotent-creation.md) — disabled
  // while waiting, unlike every other error kind's plain, always-enabled
  // "Try again" (which for a rate limit would just fail again immediately).
  // GENERATE_GUEST's ~30s refill is too long to sit through in full here;
  // this proves it's live (ticking down), not that it reaches zero — retry.ts's
  // own unit tests already prove the countdown-to-zero mechanics.
  const retryButton = alert.getByRole("button", { name: /Try again/ });
  await expect(retryButton).toBeDisabled();
  const initialText = await retryButton.textContent();
  expect(initialText).toMatch(/^Try again in \d+s$/);

  await page.waitForTimeout(2_000);

  const laterText = await retryButton.textContent();
  expect(laterText).toMatch(/^Try again in \d+s$/);
  const initialSeconds = Number(initialText?.match(/(\d+)/)?.[1]);
  const laterSeconds = Number(laterText?.match(/(\d+)/)?.[1]);
  expect(laterSeconds).toBeLessThan(initialSeconds);
});
