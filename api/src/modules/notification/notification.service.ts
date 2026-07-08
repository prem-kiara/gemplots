import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';

type Channel = 'PUSH' | 'SMS' | 'WHATSAPP';

/**
 * Notifications (CF §6). Every send is recorded in the notifications table. Real FCM/DLT senders
 * wire in at slice 10; here they log. scheduleHoldJobs enqueues reminder/expiry jobs — the
 * BullMQ queue lands in slice 7/10; for now we record intent so the flow is complete and the
 * sweeper/lazy-repair (authoritative) still guarantee expiry without the queue.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notify');

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async send(
    userId: string,
    channel: Channel,
    template: string,
    payload: Record<string, any> = {},
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO notifications (user_id, channel, template, payload, sent_at)
         VALUES ($1,$2,$3,$4, now())`,
        [userId, channel, template, JSON.stringify(payload)],
      );
      this.logger.log(`${channel} ${template} → ${userId}`);
    } catch (e: any) {
      this.logger.warn(`notify failed: ${e.message}`);
    }
  }

  /**
   * Portal-notification writer (08 §7). Inserts one portal_notifications row for the admin feed
   * or a customer's own notices. Emitted at every reserve-flow transition (08 §5). Failures are
   * logged and NEVER thrown into a business flow — a missed feed row must not roll back a
   * committed reservation. (The feed endpoints land in D3; this is only the writer.)
   */
  async feed(
    audience: 'ADMIN' | 'CUSTOMER',
    type: string,
    title: string,
    body = '',
    entityType?: string | null,
    entityId?: string | null,
    userId?: string | null,
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO portal_notifications
           (audience, user_id, type, title, body, entity_type, entity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [audience, userId ?? null, type, title, body, entityType ?? null, entityId ?? null],
      );
      this.logger.log(`feed ${audience} ${type}`);
    } catch (e: any) {
      this.logger.warn(`feed failed (${audience}/${type}): ${e.message}`);
    }
  }

  /**
   * Admin feed list (08 §7), newest first. `unread` filters to read_at IS NULL. Cursor is the
   * created_at ISO of the last row returned (stable enough Phase 1). Returns {items, next_cursor}.
   */
  async listAdmin(opts: { unread?: boolean; cursor?: string; limit?: number }) {
    const limit = clampLimit(opts.limit);
    const params: any[] = ['ADMIN'];
    let where = `audience=$1`;
    if (opts.unread) where += ` AND read_at IS NULL`;
    if (opts.cursor) {
      params.push(opts.cursor);
      where += ` AND created_at < $${params.length}`;
    }
    params.push(limit + 1);
    const rows = (
      await this.db.query(
        `SELECT id, type, title, body, entity_type, entity_id, read_at, created_at
           FROM portal_notifications
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    return this.page(rows, limit);
  }

  /** Customer's own notices (08 §7). audience CUSTOMER, user_id = caller. Newest first. */
  async listCustomer(userId: string, opts: { cursor?: string; limit?: number }) {
    const limit = clampLimit(opts.limit);
    const params: any[] = [userId];
    let where = `audience='CUSTOMER' AND user_id=$1`;
    if (opts.cursor) {
      params.push(opts.cursor);
      where += ` AND created_at < $${params.length}`;
    }
    params.push(limit + 1);
    const rows = (
      await this.db.query(
        `SELECT id, type, title, body, entity_type, entity_id, read_at, created_at
           FROM portal_notifications
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    return this.page(rows, limit);
  }

  private page(rows: any[], limit: number) {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      read_at: r.read_at ? new Date(r.read_at).toISOString() : null,
      created_at: new Date(r.created_at).toISOString(),
    }));
    return {
      items,
      next_cursor: hasMore ? new Date(rows[limit - 1].created_at).toISOString() : null,
    };
  }

  /** Unread admin count — the bell polls this every 30 s (08 §7). */
  async adminUnreadCount(): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM portal_notifications
        WHERE audience='ADMIN' AND read_at IS NULL`,
    );
    return Number(r.rows[0].n);
  }

  /** Mark one admin notification read. Shared read state — any admin clears it (08 §4/§7). */
  async markAdminRead(id: string): Promise<void> {
    await this.db.query(
      `UPDATE portal_notifications SET read_at=now()
        WHERE id=$1 AND audience='ADMIN' AND read_at IS NULL`,
      [id],
    );
  }

  /** Mark every unread admin notification read (shared read state). */
  async markAllAdminRead(): Promise<void> {
    await this.db.query(
      `UPDATE portal_notifications SET read_at=now()
        WHERE audience='ADMIN' AND read_at IS NULL`,
    );
  }

  /** Schedule T-6h / T-1h reminders (config reminder_offsets_minutes) + the expiry belt job. */
  async scheduleHoldJobs(bookingId: string, expiresAt: Date): Promise<void> {
    const offsets = await this.config.get<number[]>('reminder_offsets_minutes');
    // TODO(slice-7/10): enqueue BullMQ delayed jobs at (expiresAt - offset) and at expiresAt.
    // job-id = `${bookingId}:${offset}` for dedup (CF §6). Recorded here as intent.
    this.logger.debug(
      `schedule holds for ${bookingId}: reminders ${JSON.stringify(offsets)} before ${expiresAt.toISOString()}`,
    );
  }

  async cancelHoldJobs(bookingId: string): Promise<void> {
    // TODO(slice-7/10): remove the delayed jobs for this booking on confirm/cancel.
    this.logger.debug(`cancel hold jobs for ${bookingId}`);
  }
}

/** Clamp a client-supplied page size to a sane range (default 20, max 100). */
function clampLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}
