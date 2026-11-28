import nodemailer, { type Transporter } from 'nodemailer';
import type { ChannelService } from './channelService.js';
import { escapeHtml, renderEmail, type RenderedEmail } from './render.js';
import type { NotificationContext } from './types.js';

/**
 * Email channel (task 6.2): nodemailer SMTP delivery.
 *
 * The SMTP password comes from the encrypted credential store. `send()`
 * throws with the underlying SMTP error so the caller can surface the
 * concrete failure reason (test-send endpoint, notification log).
 */

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  to: string[];
  username?: string;
  password?: string | null;
}

export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
  close?(): void;
}

export type TransportFactory = (settings: SmtpSettings) => MailTransport;

export const defaultTransportFactory: TransportFactory = (settings) => {
  const transport: Transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.username
      ? { user: settings.username, pass: settings.password ?? '' }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    sendMail: (message) => transport.sendMail(message),
    close: () => transport.close(),
  };
};

export class EmailChannel {
  constructor(
    private readonly channels: ChannelService,
    private readonly factory: TransportFactory = defaultTransportFactory
  ) {}

  /** Resolve SMTP settings from the stored channel. */
  settings(channelId: number): SmtpSettings {
    const { config, password } = this.channels.emailConfig(channelId);
    return {
      host: config.host,
      port: config.port,
      secure: config.secure === true,
      from: config.from,
      to: config.to,
      username: config.username,
      password,
    };
  }

  render(context: NotificationContext): RenderedEmail {
    return renderEmail(context);
  }

  /** Send a review notification for the given channel. */
  async send(channelId: number, context: NotificationContext): Promise<void> {
    const settings = this.settings(channelId);
    await this.deliver(settings, this.render(context));
  }

  /** Send an arbitrary message (test-send / admin alert). */
  async sendRaw(
    channelId: number,
    message: { subject: string; text: string; html?: string; to?: string[] }
  ): Promise<void> {
    const settings = this.settings(channelId);
    const targetSettings =
      message.to && message.to.length > 0 ? { ...settings, to: message.to } : settings;
    await this.deliver(targetSettings, {
      subject: message.subject,
      text: message.text,
      html: message.html ?? `<pre>${escapeHtml(message.text)}</pre>`,
    });
  }

  private async deliver(settings: SmtpSettings, message: RenderedEmail): Promise<void> {
    if (!settings.host) throw new Error('SMTP 服务器地址未配置');
    if (settings.to.length === 0) throw new Error('收件人列表为空');
    const transport = this.factory(settings);
    try {
      await transport.sendMail({
        from: settings.from,
        to: settings.to.join(', '),
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } finally {
      transport.close?.();
    }
  }
}
