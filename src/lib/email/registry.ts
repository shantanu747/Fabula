import { consoleMailer } from "./console";
import { resendMailer } from "./resend";
import type { Mailer } from "./types";

/**
 * Registry-selected by env — the same pattern as
 * src/lib/providers/registry.ts (ADR 0001), extended to a second kind of
 * external side effect by docs/adr/0046. `ConsoleMailer` is the default
 * whenever `RESEND_API_KEY` isn't set, so a contributor who clones the repo
 * gets a working verification/reset flow with no account of any kind.
 */
export function getMailer(): Mailer {
  return process.env.RESEND_API_KEY ? resendMailer : consoleMailer;
}
