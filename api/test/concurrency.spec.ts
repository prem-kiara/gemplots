import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { makeApp, db, resetDynamic, firstPlotId, makeCustomers, closeAdminPool } from './harness';
import { BookingService } from '../src/modules/booking/booking.service';
import { AppError } from '../src/common/errors';

/**
 * TP §2.1 — the release gate for the hold engine (Invariants 2, 3). N concurrent blocks on one
 * AVAILABLE plot must produce EXACTLY ONE winner; the DB row lock + partial unique index enforce
 * it, not application checks.
 */
describe('TP §2.1 hold engine concurrency', () => {
  let app: INestApplication;
  let booking: BookingService;

  beforeAll(async () => {
    app = await makeApp();
    booking = app.get(BookingService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  it('N=50 distinct users blocking one plot → exactly one 201, rest 409 PLOT_UNAVAILABLE', async () => {
    const plotId = await firstPlotId(app);
    const users = await makeCustomers(app, 50);

    const results = await Promise.allSettled(
      users.map((uid) => booking.block(uid, plotId, randomUUID())),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter(
      (r) => r.status === 'rejected' && (r.reason as AppError)?.code === 'PLOT_UNAVAILABLE',
    );
    const other = results.filter(
      (r) => r.status === 'rejected' && (r.reason as AppError)?.code !== 'PLOT_UNAVAILABLE',
    );

    expect(wins.length).toBe(1);
    expect(losses.length).toBe(49);
    expect(other.length).toBe(0);

    const bookingRows = await db(app).query(
      `SELECT count(*)::int n FROM bookings WHERE plot_id=$1 AND status IN ('BLOCKED','BOOKED','MANUAL_REVIEW')`,
      [plotId],
    );
    expect(bookingRows.rows[0].n).toBe(1);

    const plot = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId]);
    expect(plot.rows[0].status).toBe('BLOCKED');

    const audit = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='booking.block' AND entity_id=$1`,
      [plotId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('N=50 same user + same Idempotency-Key → one booking, all others replay it', async () => {
    const plotId = await firstPlotId(app);
    const [uid] = await makeCustomers(app, 1);
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => booking.block(uid, plotId, key)),
    );

    const ids = new Set(results.map((r) => r.booking_id));
    expect(ids.size).toBe(1); // all the same booking

    const rows = await db(app).query(`SELECT count(*)::int n FROM bookings WHERE plot_id=$1`, [
      plotId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });
});
