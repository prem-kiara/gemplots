import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { EmailService } from '../../common/email/email.service';
import { NotificationService } from '../notification/notification.service';

/**
 * Deadline-reminder sweep (P8) — runs alongside the expiry sweeper. Invariant-safe: it NEVER
 * moves a deadline (Invariant 5′); it only nudges the party who still has to act before the
 * live window lapses.
 *
 *  - PENDING_CONFIRMATION nearing the OTP window end (T-<confirm_lead>) → email the customer
 *    (`reserve_reminder`) to verify.
 *  - PENDING_APPROVAL nearing the admin-decision window end (T-<approval_lead>, default 6h) →
 *    email ADMIN_ALERT_EMAIL (`approval_reminder`) + an ADMIN feed event.
 *
 * Dedup WITHOUT a schema change (the dev app is live — no new migration required at run time):
 * each reminder carries its booking_id in the emails_outbox payload, and we send only when no
 * reminder row of that template already exists for the booking. So a booking is reminded at most
 * once per threshold across every worker/lazy invocation.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger('Reminder');

  constructor(
    private readonly db: DbService,
    private readonly email: EmailService,
    private readonly notify: NotificationService,
  ) {}

  private confirmLeadMinutes(): number {
    // Lead time before the OTP window lapses. Small by default (OTP window itself is ~30m).
    return Number(process.env.RESERVE_REMINDER_LEAD_MINUTES ?? 10);
  }

  private approvalLeadMinutes(): number {
    // T-6h before the admin decision window ends (docs/09 P8).
    return Number(process.env.APPROVAL_REMINDER_LEAD_MINUTES ?? 360);
  }

  /**
   * Scan both windows and send at-most-once reminders. Best-effort: any single failure is logged
   * and the sweep continues (mirrors the expiry sweeper's post-commit discipline). Returns the
   * number of reminders sent this pass.
   */
  async sweepOnce(): Promise<number> {
    let sent = 0;
    sent += await this.remindConfirmations();
    sent += await this.remindApprovals();
    if (sent > 0) this.logger.log(`sent ${sent} deadline reminder(s)`);
    return sent;
  }

  /** PENDING_CONFIRMATION bookings whose OTP window ends within confirmLead and is not yet past. */
  private async remindConfirmations(): Promise<number> {
    const lead = this.confirmLeadMinutes();
    const due = await this.db.query<{
      id: string;
      customer_email: string;
      plot_number: string;
      project_name: string;
    }>(
      `SELECT b.id, u.email AS customer_email, p.plot_number, pr.name AS project_name
         FROM bookings b
         JOIN users u ON u.id = b.user_id
         JOIN plots p ON p.id = b.plot_id
         JOIN projects pr ON pr.id = p.project_id
        WHERE b.status = 'PENDING_CONFIRMATION'
          AND b.expires_at > now()
          AND b.expires_at <= now() + make_interval(mins => $1)
          AND NOT EXISTS (
            SELECT 1 FROM emails_outbox e
             WHERE e.template = 'reserve_reminder'
               AND e.payload->>'booking_id' = b.id::text
          )`,
      [lead],
    );

    let sent = 0;
    for (const r of due.rows) {
      try {
        await this.email.send(r.customer_email, 'reserve_reminder', {
          booking_id: r.id,
          plot_number: r.plot_number,
          project_name: r.project_name,
        });
        sent++;
      } catch (e: any) {
        this.logger.warn(`reserve_reminder failed for ${r.id}: ${e?.message}`);
      }
    }
    return sent;
  }

  /** PENDING_APPROVAL bookings whose decision window ends within approvalLead and is not yet past. */
  private async remindApprovals(): Promise<number> {
    const lead = this.approvalLeadMinutes();
    const adminAlert = process.env.ADMIN_ALERT_EMAIL ?? 'admin@gemhousing.in';
    const due = await this.db.query<{
      id: string;
      approval_id: string | null;
      customer_email: string;
      plot_number: string;
      project_name: string;
    }>(
      `SELECT b.id,
              (SELECT a.id FROM approvals a
                 WHERE a.entity_type='booking' AND a.entity_id=b.id::text AND a.status='PENDING'
                 ORDER BY a.created_at DESC LIMIT 1) AS approval_id,
              u.email AS customer_email, p.plot_number, pr.name AS project_name
         FROM bookings b
         JOIN users u ON u.id = b.user_id
         JOIN plots p ON p.id = b.plot_id
         JOIN projects pr ON pr.id = p.project_id
        WHERE b.status = 'PENDING_APPROVAL'
          AND b.expires_at > now()
          AND b.expires_at <= now() + make_interval(mins => $1)
          AND NOT EXISTS (
            SELECT 1 FROM emails_outbox e
             WHERE e.template = 'approval_reminder'
               AND e.payload->>'booking_id' = b.id::text
          )`,
      [lead],
    );

    let sent = 0;
    for (const r of due.rows) {
      try {
        await this.email.send(adminAlert, 'approval_reminder', {
          booking_id: r.id,
          approval_id: r.approval_id ?? '',
          customer_email: r.customer_email,
          plot_number: r.plot_number,
          project_name: r.project_name,
        });
        // ADMIN feed event (best-effort; never thrown into the flow).
        await this.notify.feed(
          'ADMIN',
          'APPROVAL_REMINDER',
          `Reservation for ${r.plot_number} in ${r.project_name} is nearing its decision deadline`,
          '',
          'booking',
          r.id,
        );
        sent++;
      } catch (e: any) {
        this.logger.warn(`approval_reminder failed for ${r.id}: ${e?.message}`);
      }
    }
    return sent;
  }
}
