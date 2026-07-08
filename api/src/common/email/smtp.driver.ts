import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  DriverResult,
  EmailDriver,
  EmailPayload,
  EmailTemplate,
} from './email.types';

/**
 * SMTP driver (08 §6). nodemailer against SMTP_* env; reports SENT or FAILED+error.
 * Invariant 11: the only place the nodemailer SDK is imported. Never throws — send failures are
 * recorded and swallowed so a business flow is never rolled back by a delivery error.
 */
@Injectable()
export class SmtpDriver implements EmailDriver {
  private readonly logger = new Logger('Email');
  private transport?: Transporter;

  private getTransport(): Transporter {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        auth:
          process.env.SMTP_USER || process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
      });
    }
    return this.transport;
  }

  async deliver(
    toEmail: string,
    _template: EmailTemplate,
    subject: string,
    bodyText: string,
    _payload: EmailPayload,
  ): Promise<DriverResult> {
    try {
      await this.getTransport().sendMail({
        from: process.env.SMTP_FROM,
        to: toEmail,
        subject,
        text: bodyText,
      });
      return { status: 'SENT' };
    } catch (e: any) {
      this.logger.warn(`SMTP send to ${toEmail} failed: ${e?.message}`);
      return { status: 'FAILED', error: String(e?.message ?? e) };
    }
  }
}
