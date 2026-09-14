import { describe, expect, it } from "vitest";
import { passwordResetEmail, verificationEmail } from "./templates";

describe("verificationEmail", () => {
  it("includes the link in both the html and text bodies", () => {
    const link = "https://fabula.example/api/auth/verify/abc123";
    const { html, text, subject } = verificationEmail(link);

    expect(subject).toMatch(/verify/i);
    expect(html).toContain(link);
    expect(text).toContain(link);
  });

  it("escapes the link before embedding it in HTML", () => {
    const link = 'https://fabula.example/verify/"><script>alert(1)</script>';
    const { html } = verificationEmail(link);

    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("passwordResetEmail", () => {
  it("includes the link in both the html and text bodies", () => {
    const link = "https://fabula.example/reset?token=abc123";
    const { html, text, subject } = passwordResetEmail(link);

    expect(subject).toMatch(/reset/i);
    expect(html).toContain(link);
    expect(text).toContain(link);
  });

  it("escapes the link before embedding it in HTML", () => {
    const link = 'https://fabula.example/reset?token="><img src=x onerror=alert(1)>';
    const { html } = passwordResetEmail(link);

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });
});
