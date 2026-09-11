import { test, expect } from "@playwright/test";
import { resetDatabase } from "../helpers/db";
import { getMockCallCount, hangResponse, resetMockScript, setMockScript } from "../helpers/mock";

// docs/plans/v4/02-admission-control.md — concurrency, not rate, is the thing
// under test here. Every guest request in this suite shares one identity (no
// proxy header in front of Playwright — see policy.ts's clientIp()), which is
// exactly the setup PER_IDENTITY_CAP (2) needs to be reachable by two
// deliberately concurrent calls from one spec.

test.beforeEach(async () => {
  await resetDatabase();
  await resetMockScript();
});

test("a third concurrent generation from the same caller is refused cleanly, not left hanging or crashed", async ({
  request,
}) => {
  await setMockScript(hangResponse());
  const body = { providerId: "anthropic", storySoFar: [] };

  // Fired and deliberately not awaited to completion: hangResponse() never
  // answers, so each of these holds an admission lease open (route.ts
  // acquires it before ever calling the provider) for as long as the test
  // needs it to. Swallowed rather than awaited later — this suite doesn't
  // need the real ~20s FIRST_CHUNK_TIMEOUT_MS to elapse to prove the point,
  // and the next spec's beforeEach (resetDatabase()'s Redis flush) clears
  // both leases regardless of whether these requests actually finish
  // server-side. Two, not one: PER_IDENTITY_CAP is 2 (src/lib/admission/
  // lease.ts), sized to tolerate a legitimate second tab, so both slots need
  // to be held before a third request has anything to be refused for.
  const held = [
    request.post("/api/generate", { data: body }).catch(() => {}),
    request.post("/api/generate", { data: body }).catch(() => {}),
  ];

  // There's no external signal for "both held requests have reached the
  // admission check" — polling the mock's call count is the honest proxy:
  // the mock only sees a call once rate-limit, admission, and budget have all
  // already passed and route.ts has reached attemptFirstChunk() for each.
  await expect.poll(() => getMockCallCount()).toBeGreaterThanOrEqual(2);

  const third = await request.post("/api/generate", { data: body });

  expect(third.status()).toBe(429);
  const thirdBody = await third.json();
  expect(thirdBody.kind).toBe("at-capacity");
  expect(thirdBody.error).toMatch(/already have a story generating/i);
  expect(Number(third.headers()["retry-after"])).toBeGreaterThanOrEqual(1);

  void held;
});
