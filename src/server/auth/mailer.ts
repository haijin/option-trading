export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** How the sign-in link leaves the server. `console` is the default: the link is printed in the server's own terminal. */
export interface Mailer {
  readonly kind: 'smtp' | 'console';
  send(message: MailMessage): Promise<void>;
}

/** No mail server configured: the operator reads the link in the server log (the app says so on the login page). */
export class ConsoleMailer implements Mailer {
  readonly kind = 'console' as const;

  constructor(private readonly log: (line: string) => void) {}

  async send(m: MailMessage): Promise<void> {
    this.log(`[mail not configured] To: ${m.to}\n${m.subject}\n${m.text}`);
  }
}

/** SMTP through nodemailer, loaded on first use so a server without mail never pays for it. */
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;

  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}

  async send(m: MailMessage): Promise<void> {
    const { createTransport } = await import('nodemailer');
    const transport = createTransport(this.url);
    try {
      await transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    } finally {
      transport.close();
    }
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The sign-in email: a button for people, the bare link for plain-text clients. */
export function signInMessage(to: string, link: string, minutes: number): MailMessage {
  const href = escapeHtml(link);
  return {
    to,
    subject: 'Your Option Trading sign-in link',
    text: `Open this link to sign in to Option Trading (it works once and expires in ${minutes} minutes):\n\n${link}\n\nIf you did not ask for it, ignore this email: nobody can sign in without the link.`,
    html: `<p>Open this link to sign in to Option Trading. It works once and expires in ${minutes} minutes.</p><p><a href="${href}" style="display:inline-block;padding:10px 18px;background:#128c7e;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a></p><p style="color:#54656f;font-size:13px">Or paste this address into your browser:<br>${href}</p><p style="color:#54656f;font-size:13px">If you did not ask for it, ignore this email: nobody can sign in without the link.</p>`,
  };
}
