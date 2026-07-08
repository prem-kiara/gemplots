import { Injectable, Logger } from '@nestjs/common';
import { DbService, Executor } from '../../common/db/db.service';
import { AuditService, SYSTEM_ACTOR } from '../../common/audit/audit.service';
import { RedisService } from '../../common/redis/redis.service';
import { EmailService } from '../../common/email/email.service';
import { NotificationService } from '../notification/notification.service';

/**
 * Expiry — the guarded PENDING_CONFIRMATION|PENDING_APPROVAL → EXPIRED transition (08 §5, CF §3,
 * Invariant 6), shared by all three defenses: sweeper (authoritative), per-booking delayed job
 * (belt), lazy repair on read (belt #2). The guarded UPDATE makes every path safely concurrent:
 * whoever gets there first wins, the rest touch 0 rows. On transition it frees the plot
 * (ON_HOLD → AVAILABLE) and auto-WITHDRAWs any PENDING approval for the booking.
 *
 * Dormant BLOCKED bookings (payment fixtures) are NOT swept — the status filter excludes them.
 */
@Injectable()
export class ExpiryService {
  private readonly logger = new Logger('Expiry');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly notify: NotificationService,
  ) {}

  /**
   * Expire one booking if (and only if) it is still in a pending reserve state and truly past
   * expires_at. Runs inside the provided Executor. Returns a notice payload (for the post-commit
   * customer email + admin feed) when this call performed the transition, else null.
   */
  private async expireOne(
    ex: Executor,
    bookingId: string,
    plotId: string,
  ): Promise<{ customerEmail: string; plotNumber: string; projectName: string } | null> {
    const updated = await ex.query(
      `UPDATE bookings SET status='EXPIRED', closed_at=now()
        WHERE id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')
          AND expires_at <= now()`,
      [bookingId],
    );
    if (updated.rowCount === 0) return null; // someone else handled it, or it moved on

    await ex.query(
      `UPDATE plots SET status='AVAILABLE' WHERE id=$1 AND status='ON_HOLD'`,
      [plotId],
    );
    // Auto-withdraw any PENDING approval for this booking (decided_by stays NULL — the CHECK
    // allows it since decided_by IS NULL).
    await ex.query(
      `UPDATE approvals
          SET status='WITHDRAWN', decision_note='auto-expired', decided_at=now()
        WHERE entity_type='booking' AND entity_id=$1 AND status='PENDING'`,
      [bookingId],
    );
    await this.audit.log(
      ex,
      SYSTEM_ACTOR,
      'booking.expire',
      'booking',
      bookingId,
      { status: 'PENDING' },
      { status: 'EXPIRED' },
    );

    const facts = (
      await ex.query(
        `SELECT u.email AS customer_email, p.plot_number, pr.name AS project_name
           FROM bookings b
           JOIN users u ON u.id = b.user_id
           JOIN plots p ON p.id = b.plot_id
           JOIN projects pr ON pr.id = p.project_id
          WHERE b.id=$1`,
        [bookingId],
      )
    ).rows[0];
    return {
      customerEmail: facts?.customer_email,
      plotNumber: facts?.plot_number,
      projectName: facts?.project_name,
    };
  }

  /** Post-commit side-effects for an expired booking — email the customer, feed the admin. */
  private async afterExpire(
    bookingId: string,
    notice: { customerEmail: string; plotNumber: string; projectName: string },
  ): Promise<void> {
    await this.redis.delHold(bookingId);
    if (notice.customerEmail)
      await this.email.send(notice.customerEmail, 'reservation_expired', {
        plot_number: notice.plotNumber,
        project_name: notice.projectName,
      });
    await this.notify.feed(
      'ADMIN',
      'RESERVATION_EXPIRED',
      `Reservation for ${notice.plotNumber ?? 'a plot'} expired and was released`,
      '',
      'booking',
      bookingId,
    );
  }

  /**
   * Lazy repair (CF §3.3): before serving any plot/booking read, expire any due reserve holds on
   * the given plots. Each in its own short TX so a single failure doesn't block the read.
   */
  async repairPlots(plotIds: string[]): Promise<number> {
    if (plotIds.length === 0) return 0;
    const due = await this.db.query<{ id: string; plot_id: string }>(
      `SELECT id, plot_id FROM bookings
        WHERE plot_id = ANY($1::uuid[])
          AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL') AND expires_at <= now()`,
      [plotIds],
    );
    let repaired = 0;
    for (const row of due.rows) {
      const notice = await this.db
        .tx((tx) => this.expireOne(tx, row.id, row.plot_id))
        .catch((e) => {
          this.logger.warn(`lazy repair failed for ${row.id}: ${e.message}`);
          return null;
        });
      if (notice) {
        repaired++;
        await this.afterExpire(row.id, notice);
      }
    }
    return repaired;
  }

  async repairBooking(bookingId: string): Promise<void> {
    const row = (
      await this.db.query<{ plot_id: string }>(`SELECT plot_id FROM bookings WHERE id=$1`, [
        bookingId,
      ])
    ).rows[0];
    if (row) await this.repairPlots([row.plot_id]);
  }

  /**
   * Sweeper (authoritative, CF §3.1): batch-expire all due reserve holds. FOR UPDATE SKIP LOCKED
   * so multiple workers coexist and it never blocks the reserve endpoint. Returns count expired.
   */
  async sweepOnce(batchSize = 100): Promise<number> {
    let total = 0;
    for (;;) {
      const notices = await this.db.tx(async (tx) => {
        const due = await tx.query<{ id: string; plot_id: string }>(
          `SELECT id, plot_id FROM bookings
            WHERE status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL') AND expires_at <= now()
            ORDER BY expires_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1`,
          [batchSize],
        );
        const out: {
          id: string;
          notice: { customerEmail: string; plotNumber: string; projectName: string };
        }[] = [];
        for (const r of due.rows) {
          const notice = await this.expireOne(tx, r.id, r.plot_id);
          if (notice) out.push({ id: r.id, notice });
        }
        return out;
      });
      for (const n of notices) await this.afterExpire(n.id, n.notice);
      total += notices.length;
      if (notices.length < batchSize) break;
    }
    if (total > 0) this.logger.log(`sweeper expired ${total} reservation(s)`);
    return total;
  }
}
