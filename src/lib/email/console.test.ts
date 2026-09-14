import { afterEach, describe, expect, it, vi } from "vitest";
import { __clearSentEmailsForTests, __getSentEmailsForTests, consoleMailer } from "./console";

afterEach(() => __clearSentEmailsForTests());

describe("consoleMailer", () => {
  it("logs the recipient, subject, and body instead of sending anything", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await consoleMailer.send({
      to: "writer@example.com",
      subject: "Verify your email",
      html: "<p>link</p>",
      text: "link",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("writer@example.com");
    expect(line).toContain("Verify your email");
    expect(line).toContain("link");

    logSpy.mockRestore();
  });

  it("captures every send for test recovery (the E2E verification/reset flows)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const email = { to: "writer@example.com", subject: "s", html: "h", text: "t" };
    await consoleMailer.send(email);

    expect(__getSentEmailsForTests()).toEqual([email]);
  });

  it("__clearSentEmailsForTests empties the capture", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await consoleMailer.send({ to: "a@example.com", subject: "s", html: "h", text: "t" });

    __clearSentEmailsForTests();

    expect(__getSentEmailsForTests()).toEqual([]);
  });
});
