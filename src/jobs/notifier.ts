/**
 * Optional push of new alerts (docs/06 Phase 3). Nothing is sent unless a channel is configured in the environment:
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   a message through the Telegram Bot API
 *   OT_SMTP_URL + OT_ALERT_EMAIL            an email through the same SMTP settings as the sign-in link
 * The message carries only symbols, strikes and rule text; no account or credential data.
 */
export interface Notification {
  title: string;
  lines: string[];
}

export interface Notifier {
  readonly kind: string;
  send(n: Notification): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  readonly kind = 'telegram';

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  async send(n: Notification): Promise<void> {
    const text = [n.title, ...n.lines].join('\n').slice(0, 4000);
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    // The URL holds the token: report the status only, never the request.
    if (!res.ok) throw new Error(`Telegram answered HTTP ${res.status}`);
  }
}

/** SMTP through nodemailer, loaded on first use. A sender of its own (not the sign-in mailer) keeps this module free of the server. */
export class EmailNotifier implements Notifier {
  readonly kind = 'email';

  constructor(
    private readonly smtpUrl: string,
    private readonly from: string,
    private readonly to: string,
  ) {}

  async send(n: Notification): Promise<void> {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const { createTransport } = await import('nodemailer');
    const transport = createTransport(this.smtpUrl);
    try {
      await transport.sendMail({
        from: this.from,
        to: this.to,
        subject: n.title,
        text: [n.title, '', ...n.lines].join('\n'),
        html: `<p><b>${esc(n.title)}</b></p><ul>${n.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
      });
    } finally {
      transport.close();
    }
  }
}

/** Sends to every channel, and reports a failed channel without stopping the others. */
export class MultiNotifier implements Notifier {
  readonly kind: string;

  constructor(
    private readonly parts: Notifier[],
    private readonly log: (line: string) => void,
  ) {
    this.kind = parts.map((p) => p.kind).join('+');
  }

  async send(n: Notification): Promise<void> {
    for (const p of this.parts) {
      try {
        await p.send(n);
      } catch (err) {
        this.log(`notification via ${p.kind} failed: ${(err as Error).message}`);
      }
    }
  }
}

export function notifierFromEnv(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  log: (line: string) => void,
): Notifier | null {
  const parts: Notifier[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    parts.push(new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, fetchFn));
  if (env.OT_SMTP_URL && env.OT_ALERT_EMAIL)
    parts.push(
      new EmailNotifier(
        env.OT_SMTP_URL,
        env.OT_MAIL_FROM?.trim() || 'Option Trading <no-reply@localhost>',
        env.OT_ALERT_EMAIL,
      ),
    );
  return parts.length === 0 ? null : new MultiNotifier(parts, log);
}
