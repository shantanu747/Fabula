interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Escapes the handful of characters that matter inside the plain-text
 *  templates below — there is no user-authored story content in an email, so
 *  this only ever sees a link or a name, but cheap to do properly regardless. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function verificationEmail(link: string): EmailContent {
  const safeLink = escapeHtml(link);
  return {
    subject: "Verify your Fabula email",
    html: `<p>Confirm your email address to share stories to the Fabula feed:</p><p><a href="${safeLink}">${safeLink}</a></p><p>This link expires in 24 hours. If you didn't create a Fabula account, you can ignore this email.</p>`,
    text: `Confirm your email address to share stories to the Fabula feed:\n\n${link}\n\nThis link expires in 24 hours. If you didn't create a Fabula account, you can ignore this email.`,
  };
}

export function passwordResetEmail(link: string): EmailContent {
  const safeLink = escapeHtml(link);
  return {
    subject: "Reset your Fabula password",
    html: `<p>Reset your Fabula password:</p><p><a href="${safeLink}">${safeLink}</a></p><p>This link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email — your password won't change.</p>`,
    text: `Reset your Fabula password:\n\n${link}\n\nThis link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email — your password won't change.`,
  };
}
