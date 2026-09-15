/** Plain multipart content — every call site supplies both, so a Mailer never
 *  has to derive one from the other (an HTML-to-text reduction is lossy and
 *  not worth the one extra line each caller already writes instead). */
export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Mirrors src/lib/providers/'s LLMProvider shape (ADR 0001): one interface,
 *  swapped by a registry, never called directly from a route handler. */
export interface Mailer {
  id: string;
  send(input: SendEmailInput): Promise<void>;
}
