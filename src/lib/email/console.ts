import type { Mailer, SendEmailInput } from "./types";

/**
 * Held in module scope so E2E specs can recover a verification/reset link
 * without a real inbox — this Mailer is exactly what runs under Playwright's
 * webServer (no RESEND_API_KEY there), and the link is otherwise only ever
 * known transiently (the token itself is stored hashed, docs/adr/0046).
 * Small and unbounded-but-harmless: this only ever runs in dev/CI/E2E
 * processes, never in a real deployment (registry.ts selects ResendMailer
 * once RESEND_API_KEY is set), so there is no production process for this
 * array to grow unboundedly inside.
 */
const sentEmails: SendEmailInput[] = [];

/**
 * Logs the email instead of sending it. The default whenever no real provider
 * is configured (see registry.ts), which keeps dev, CI, and E2E keyless and
 * makes the verification/reset flows testable end to end without a network —
 * the "click the link from the console" flow docs/adr/0046 describes.
 */
export const consoleMailer: Mailer = {
  id: "console",
  async send(input: SendEmailInput): Promise<void> {
    console.log(`[email:console] to=${input.to} subject=${JSON.stringify(input.subject)}\n${input.text}`);
    sentEmails.push(input);
  },
};

/** Test-only seam — see the `%5F%5Ftest/last-email` route, which is the
 *  only production code that reads this outside a test. */
export function __getSentEmailsForTests(): readonly SendEmailInput[] {
  return sentEmails;
}

export function __clearSentEmailsForTests(): void {
  sentEmails.length = 0;
}
