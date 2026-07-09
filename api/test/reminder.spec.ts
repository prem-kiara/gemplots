import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  makeApp,
  db,
  resetDynamic,
  firstPlotId,
  makeCustomers,
  closeAdminPool,
} from './harness';
import { BookingService } from '../src/modules/booking/booking.service';
import { ReservationService } from '../src/modules/booking/reservation.service';
import { ReminderService } from '../src/modules/booking/reminder.service';

/**
 * P8 — deadline-reminder sweep. Reminders are Invariant-safe (they never move a deadline) and
 * dedup to at-most-once per booking per threshold via emails_outbox.
 */
describe('P8 deadline reminders', () => {
  let app: INestApplication;
  let booking: BookingService;
  let reservations: ReservationService;
  let reminders: ReminderService;

  beforeAll(async () => {
    app = await makeApp();
    booking = app.get(BookingService);
    reservations = app.get(ReservationService);
    reminders = app.get(ReminderService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  /** A PENDING_CONFIRMATION reservation whose OTP window ends inside the reminder lead. */
  async function makeNearOtpDeadline() {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    // 5 minutes left → inside the default 10-minute confirm lead.
    await db(app).query(
      `UPDATE bookings SET expires_at = now() + interval '5 minutes' WHERE id=$1`,
      [r.booking_id],
    );
    return { bookingId: r.booking_id, plotId, userId };
  }

  /** A PENDING_APPROVAL reservation whose decision window ends inside the approval lead. */
  async function makeNearApprovalDeadline() {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    await reservations.confirm(r.booking_id, r.challenge_id, r.dev_otp!, { id: userId });
    // 2 hours left → inside the default 6-hour (360-min) approval lead.
    await db(app).query(
      `UPDATE bookings SET expires_at = now() + interval '2 hours' WHERE id=$1`,
      [r.booking_id],
    );
    return { bookingId: r.booking_id, plotId, userId };
  }

  it('reminds a PENDING_CONFIRMATION customer nearing the OTP window (reserve_reminder), once', async () => {
    const { bookingId } = await makeNearOtpDeadline();
    const before = new Date(
      (await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [bookingId])).rows[0]
        .expires_at,
    ).getTime();

    const n1 = await reminders.sweepOnce();
    expect(n1).toBe(1);

    const outbox = await db(app).query(
      `SELECT to_email FROM emails_outbox WHERE template='reserve_reminder'
         AND payload->>'booking_id'=$1`,
      [bookingId],
    );
    expect(outbox.rowCount).toBe(1);

    // Invariant 5′: the deadline did not move.
    const after = new Date(
      (await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [bookingId])).rows[0]
        .expires_at,
    ).getTime();
    expect(after).toBe(before);

    // Dedup: a second sweep sends nothing.
    const n2 = await reminders.sweepOnce();
    expect(n2).toBe(0);
    const outbox2 = await db(app).query(
      `SELECT count(*)::int n FROM emails_outbox WHERE template='reserve_reminder'
         AND payload->>'booking_id'=$1`,
      [bookingId],
    );
    expect(outbox2.rows[0].n).toBe(1);
  });

  it('reminds ADMIN for a PENDING_APPROVAL nearing its decision window (approval_reminder + feed), once', async () => {
    const { bookingId } = await makeNearApprovalDeadline();

    const n1 = await reminders.sweepOnce();
    expect(n1).toBe(1);

    const outbox = await db(app).query(
      `SELECT to_email FROM emails_outbox WHERE template='approval_reminder'
         AND payload->>'booking_id'=$1`,
      [bookingId],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].to_email).toBe(process.env.ADMIN_ALERT_EMAIL ?? 'admin@gemhousing.in');

    // ADMIN feed event emitted.
    const feed = await db(app).query(
      `SELECT count(*)::int n FROM portal_notifications
         WHERE type='APPROVAL_REMINDER' AND entity_id=$1`,
      [bookingId],
    );
    expect(feed.rows[0].n).toBe(1);

    // Dedup.
    const n2 = await reminders.sweepOnce();
    expect(n2).toBe(0);
  });

  it('does NOT remind a booking whose deadline is far away or already past', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    // Far in the future (default OTP window ~30m, well outside the 10-min lead).
    await db(app).query(
      `UPDATE bookings SET expires_at = now() + interval '25 minutes' WHERE id=$1`,
      [r.booking_id],
    );
    expect(await reminders.sweepOnce()).toBe(0);

    // Already past → the expiry sweeper's job, not the reminder's.
    await db(app).query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [r.booking_id],
    );
    expect(await reminders.sweepOnce()).toBe(0);
  });
});
