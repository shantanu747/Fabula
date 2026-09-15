import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { __clearSentEmailsForTests, consoleMailer } from "@/lib/email/console";

function request(to?: string): Request {
  const url = new URL("http://localhost/api/__test/last-email");
  if (to !== undefined) url.searchParams.set("to", to);
  return new Request(url);
}

const originalMode = process.env.E2E_TEST_MODE;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __clearSentEmailsForTests();
  if (originalMode === undefined) delete process.env.E2E_TEST_MODE;
  else process.env.E2E_TEST_MODE = originalMode;
  vi.restoreAllMocks();
});

describe("GET /api/__test/last-email", () => {
  it("404s when E2E_TEST_MODE isn't set — indistinguishable from a route that doesn't exist", async () => {
    delete process.env.E2E_TEST_MODE;
    const response = await GET(request("writer@example.com"));
    expect(response.status).toBe(404);
  });

  it("400s with no `to` query param, even in test mode", async () => {
    process.env.E2E_TEST_MODE = "1";
    const response = await GET(request());
    expect(response.status).toBe(400);
  });

  it("404s when nothing was ever sent to that address", async () => {
    process.env.E2E_TEST_MODE = "1";
    const response = await GET(request("nobody@example.com"));
    expect(response.status).toBe(404);
  });

  it("returns the most recent email sent to the given address", async () => {
    process.env.E2E_TEST_MODE = "1";
    await consoleMailer.send({ to: "writer@example.com", subject: "First", html: "h", text: "first link" });
    await consoleMailer.send({ to: "writer@example.com", subject: "Second", html: "h", text: "second link" });
    await consoleMailer.send({ to: "someone-else@example.com", subject: "Other", html: "h", text: "other link" });

    const response = await GET(request("writer@example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subject: "Second", text: "second link" });
  });
});
