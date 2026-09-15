import type { Mailer, SendEmailInput } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Talks to Resend's REST API directly via `fetch` rather than adding the
 * `resend` npm package for what is, underneath, a single JSON POST —
 * AGENTS.md's "check the stack already covers it" rule, applied the same way
 * openrouter.ts reuses an existing HTTP-capable client instead of a
 * dedicated SDK for a provider with no official one in this dependency tree.
 */
export const resendMailer: Mailer = {
  id: "resend",
  async send(input: SendEmailInput): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("resendMailer.send called with no RESEND_API_KEY configured");
    }

    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? "Fabula <onboarding@resend.dev>",
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!response.ok) {
      throw new Error(`resendMailer.send failed: ${response.status} ${await response.text()}`);
    }
  },
};
