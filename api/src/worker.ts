import { INestApplicationContext, Logger } from '@nestjs/common';
import { ExpiryService } from './modules/booking/expiry.service';
import { ReminderService } from './modules/booking/reminder.service';

/**
 * Worker mode (CF §3.1). Runs the authoritative expiry sweeper every 60s, and (P8) the
 * deadline-reminder sweep alongside it. BullMQ repeatable jobs can replace this scheduler later;
 * the transitions themselves (ExpiryService.sweepOnce / ReminderService.sweepOnce) are the same
 * code either way, so correctness is unchanged.
 */
export async function startWorkers(app: INestApplicationContext) {
  const logger = new Logger('Worker');
  const expiry = app.get(ExpiryService);
  const reminders = app.get(ReminderService);
  const intervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);

  const tick = async () => {
    try {
      await expiry.sweepOnce();
    } catch (e: any) {
      logger.error(`sweep failed: ${e.message}`);
    }
    try {
      await reminders.sweepOnce();
    } catch (e: any) {
      logger.error(`reminder sweep failed: ${e.message}`);
    }
  };
  setInterval(tick, intervalMs).unref();
  logger.log(`expiry + reminder sweeper started (every ${intervalMs}ms)`);
}
