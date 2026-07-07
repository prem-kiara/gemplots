import { Injectable, Logger } from '@nestjs/common';
import { DbService, Executor } from '../../common/db/db.service';
import { AuditService, SYSTEM_ACTOR } from '../../common/audit/audit.service';
import { RedisService } from '../../common/redis/redis.service';

/**
 * Expiry — the single BLOCKED→EXPIRED transition, shared by all three defenses (CF §3,
 * Invariant 6): sweeper (authoritative), per-booking delayed job (belt), lazy repair on read
 * (belt #2). The guarded UPDATE makes every path safely concurrent: whoever gets there first
 * wins, the rest touch 0 rows.
 */
@Injectable()
export class ExpiryService {
  private readonly logger = new Logger('Expiry');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Expire one booking if (and only if) it is still BLOCKED and truly past expires_at.
   * Runs inside the provided Executor (its own short TX for lazy repair; the sweeper batch TX
   * for the sweeper). Returns true if this call performed the transition.
   */
  private async expireOne(ex: Executor, bookingId: string, plotId: string): Promise<boolean> {
    const updated = await ex.query(
      `UPDATE bookings SET status='EXPIRED', closed_at=now()
        WHERE id=$1 AND status='BLOCKED' AND expires_at <= now()`,
      [bookingId],
    );
    if (updated.rowCount === 0) return false; // someone else handled it, or it got paid

    await ex.query(
      `UPDATE plots SET status='AVAILABLE' WHERE id=$1 AND status='BLOCKED'`,
      [plotId],
    );
    await this.audit.log(
      ex,
      SYSTEM_ACTOR,
      'booking.expire',
      'booking',
      bookingId,
      { status: 'BLOCKED' },
      { status: 'EXPIRED' },
    );
    return true;
  }

  /**
   * Lazy repair (CF §3.3): before serving any plot/booking read, expire any due holds on the
   * given plots. Each in its own short TX so a single failure doesn't block the read.
   */
  async repairPlots(plotIds: string[]): Promise<number> {
    if (plotIds.length === 0) return 0;
    const due = await this.db.query<{ id: string; plot_id: string }>(
      `SELECT id, plot_id FROM bookings
        WHERE plot_id = ANY($1::uuid[]) AND status='BLOCKED' AND expires_at <= now()`,
      [plotIds],
    );
    let repaired = 0;
    for (const row of due.rows) {
      const did = await this.db
        .tx((tx) => this.expireOne(tx, row.id, row.plot_id))
        .catch((e) => {
          this.logger.warn(`lazy repair failed for ${row.id}: ${e.message}`);
          return false;
        });
      if (did) {
        repaired++;
        await this.redis.delHold(row.id);
      }
    }
    return repaired;
  }

  async repairBooking(bookingId: string): Promise<void> {
    const row = (
      await this.db.query<{ plot_id: string }>(
        `SELECT plot_id FROM bookings WHERE id=$1`,
        [bookingId],
      )
    ).rows[0];
    if (row) await this.repairPlots([row.plot_id]);
  }

  /**
   * Sweeper (authoritative, CF §3.1): batch-expire all due holds. FOR UPDATE SKIP LOCKED so
   * multiple workers coexist and it never blocks the block endpoint. Returns count expired.
   */
  async sweepOnce(batchSize = 100): Promise<number> {
    let total = 0;
    for (;;) {
      const expiredIds = await this.db.tx(async (tx) => {
        const due = await tx.query<{ id: string; plot_id: string }>(
          `SELECT id, plot_id FROM bookings
            WHERE status='BLOCKED' AND expires_at <= now()
            ORDER BY expires_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1`,
          [batchSize],
        );
        const ids: string[] = [];
        for (const r of due.rows) {
          if (await this.expireOne(tx, r.id, r.plot_id)) ids.push(r.id);
        }
        return ids;
      });
      for (const id of expiredIds) await this.redis.delHold(id);
      total += expiredIds.length;
      if (expiredIds.length < batchSize) break;
    }
    if (total > 0) this.logger.log(`sweeper expired ${total} hold(s)`);
    return total;
  }
}
