import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ConsoleDriver } from './console.driver';
import { SmtpDriver } from './smtp.driver';
import { renderEmail } from './templates';
import { EmailDriver, EmailPayload, EmailTemplate } from './email.types';

/**
 * EmailService (08 §6): render subject/body → ALWAYS insert an emails_outbox row → hand to the
 * driver chosen by EMAIL_MODE (console default | smtp). The outbox row is written first so no
 * email can bypass the outbox (HANDOVER). Send is a side effect: failures are recorded and never
 * thrown into a business flow (Invariant 11).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');

  constructor(
    private readonly db: DbService,
    private readonly consoleDriver: ConsoleDriver,
    private readonly smtpDriver: SmtpDriver,
  ) {}

  /** Chosen at send time (no caching) — matches the dev_otp double-gate reading env live. */
  private driver(): EmailDriver {
    return (process.env.EMAIL_MODE ?? 'console') === 'smtp'
      ? this.smtpDriver
      : this.consoleDriver;
  }

  async send(
    toEmail: string,
    template: EmailTemplate,
    payload: EmailPayload = {},
  ): Promise<void> {
    try {
      const { subject, bodyText } = renderEmail(template, payload);
      // Always record the intent first (LOGGED as a neutral pre-send state).
      const row = (
        await this.db.query<{ id: string }>(
          `INSERT INTO emails_outbox (to_email, template, subject, body_text, payload, status)
           VALUES ($1,$2,$3,$4,$5,'LOGGED') RETURNING id`,
          [toEmail, template, subject, bodyText, JSON.stringify(payload)],
        )
      ).rows[0];

      const result = await this.driver().deliver(
        toEmail,
        template,
        subject,
        bodyText,
        payload,
      );

      // Reflect the driver's outcome. Console driver stays LOGGED; SMTP → SENT/FAILED.
      await this.db.query(
        `UPDATE emails_outbox
            SET status = $2,
                error = $3,
                sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END
          WHERE id = $1`,
        [row.id, result.status, result.error ?? null],
      );
    } catch (e: any) {
      // Email must never break a business flow. Record-and-continue.
      this.logger.warn(`email send (${template} → ${toEmail}) failed: ${e?.message}`);
    }
  }
}
