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
