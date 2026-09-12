import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { AppConfig, MailConfig, StoreConfig } from '../../config/configuration';

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative, for clients that do not render HTML and for spam filters that expect both. */
  text?: string;
}

export interface SendMailResult {
  messageId: string;
  /** Populated by the JSON transport in tests, so assertions can read the body. */
  message?: string;
}

/**
 * Sends email through the shop's own SMTP mailbox — Hostinger:
 * `smtp.hostinger.com`, port 465 with SSL, or 587 with STARTTLS.
 *
 * The test suite never sends anything: it swaps in Nodemailer's JSON transport,
 * which serialises the message so tests can assert on the real rendered output.
 */
@Injectable()
export class MailerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly mail: MailConfig;
  private readonly replyTo: string;
  private readonly live: boolean;

  constructor(config: ConfigService) {
    this.mail = config.getOrThrow<MailConfig>('mail');
    this.replyTo = config.getOrThrow<StoreConfig>('store').supportEmail;
    this.live = config.getOrThrow<AppConfig>('app').env !== 'test';

    this.transporter = this.live
      ? nodemailer.createTransport({
          host: this.mail.host,
          port: this.mail.port,
          secure: this.mail.secure,
          // Port 587 starts in plain text and upgrades. Refuse to go on if the
          // upgrade is not offered, rather than sending the password in the clear.
          requireTLS: !this.mail.secure && this.mail.port === 587,
          ...(this.mail.user ? { auth: { user: this.mail.user, pass: this.mail.pass } } : {}),
          // Pooled but narrow: shared-hosting mailboxes throttle concurrent
          // connections, and a refused connection is a failed send.
          pool: true,
          maxConnections: 3,
          // Without these a server that accepts the connection and then stalls
          // holds a queue worker indefinitely.
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 30_000,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }

  onModuleInit(): void {
    if (!this.live) return;
    this.warnAboutSettings();

    // Checked in the background: a mail outage must not stop the shop from
    // starting, but it should be the first thing anyone reading the log sees.
    void this.transporter.verify().then(
      () =>
        this.logger.log(
          `SMTP ready: ${this.mail.host}:${this.mail.port} as ${this.mail.user ?? '(no login)'}`,
        ),
      (error: unknown) =>
        this.logger.error(
          `SMTP check failed for ${this.mail.host}:${this.mail.port} — emails will not be ` +
            `delivered until this is fixed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  /** Point out the two mistakes that make every send fail quietly. */
  private warnAboutSettings(): void {
    const values = [this.mail.user, this.mail.pass, this.mail.from];
    if (values.some((value) => value?.toUpperCase().includes('CHANGE_ME'))) {
      this.logger.error(
        'SMTP settings in .env still contain CHANGE_ME placeholders — fill in the Hostinger ' +
          'mailbox (SMTP_USER), its password (SMTP_PASS) and MAIL_FROM.',
      );
    }

    const fromAddress = (/<([^>]+)>/.exec(this.mail.from)?.[1] ?? this.mail.from).trim();
    if (this.mail.user && fromAddress.toLowerCase() !== this.mail.user.toLowerCase()) {
      this.logger.warn(
        `MAIL_FROM (${fromAddress}) differs from SMTP_USER (${this.mail.user}). Hostinger only ` +
          'lets a mailbox send as itself — use the same address in both.',
      );
    }
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    // Errors propagate: the queue processor turns a failure into a retry with
    // backoff, and eventually a dead-lettered job. Swallowing here would lose
    // the message silently.
    const info = (await this.transporter.sendMail({
      from: this.mail.from,
      to: input.to,
      // Customers who reply reach the support inbox, not a no-reply mailbox.
      replyTo: this.replyTo,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
    })) as nodemailer.SentMessageInfo & { message?: string };

    this.logger.log(`Sent "${input.subject}" to ${input.to}`);
    return { messageId: String(info.messageId), message: info.message };
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }
}
