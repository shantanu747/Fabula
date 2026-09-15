import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resendMailer } from "./resend";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.RESEND_API_KEY = "test-resend-key";
  delete process.env.EMAIL_FROM;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("resendMailer", () => {
  it("throws rather than silently no-op-ing when no API key is configured", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(
      resendMailer.send({ to: "writer@example.com", subject: "s", html: "h", text: "t" })
    ).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("posts to Resend's API with the expected shape", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await resendMailer.send({ to: "writer@example.com", subject: "Verify", html: "<p>hi</p>", text: "hi" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-resend-key" }),
      })
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ to: ["writer@example.com"], subject: "Verify", html: "<p>hi</p>", text: "hi" });
  });

  it("uses EMAIL_FROM when set, and a sensible default otherwise", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await resendMailer.send({ to: "a@example.com", subject: "s", html: "h", text: "t" });
    let body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.from).toContain("resend.dev");

    process.env.EMAIL_FROM = "Fabula <noreply@fabula.example>";
    await resendMailer.send({ to: "a@example.com", subject: "s", html: "h", text: "t" });
    body = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(body.from).toBe("Fabula <noreply@fabula.example>");
  });

  it("throws with the status and body when Resend rejects the request", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("bad request", { status: 422 }));

    await expect(
      resendMailer.send({ to: "writer@example.com", subject: "s", html: "h", text: "t" })
    ).rejects.toThrow(/422/);
  });
});
