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
import { BookingReadService } from '../src/modules/booking/booking-read.service';
import { ExpiryService } from '../src/modules/booking/expiry.service';
import { ConfigService } from '../src/common/config/config.service';
import { CatalogReadService } from '../src/modules/catalog/catalog-read.service';

/** TP §2.2 — expiry defended three ways (Invariants 5, 6). Worker-down is the release gate. */
describe('TP §2.2 expiry defenses', () => {
  let app: INestApplication;
  let booking: BookingService;
  let expiry: ExpiryService;
  let reads: BookingReadService;
  let catalog: CatalogReadService;

  beforeAll(async () => {
    app = await makeApp();
    booking = app.get(BookingService);
    expiry = app.get(ExpiryService);
    reads = app.get(BookingReadService);
    catalog = app.get(CatalogReadService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  /** Force a booking's expires_at into the past (owner conn) to simulate elapsed time. */
  async function makeDueBooking(): Promise<{ bookingId: string; plotId: string; userId: string }> {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.block(userId, plotId, randomUUID());
    await db(app).query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [r.booking_id],
    );
    return { bookingId: r.booking_id, plotId, userId };
  }

  it('(a) sweeper expires due holds and frees the plot + audit row', async () => {
    const { bookingId, plotId } = await makeDueBooking();
    const n = await expiry.sweepOnce();
    expect(n).toBe(1);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('EXPIRED');
    const p = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId]);
    expect(p.rows[0].status).toBe('AVAILABLE');
    const a = await db(app).query(
      `SELECT actor_role FROM audit_logs WHERE action='booking.expire' AND entity_id=$1`,
      [bookingId],
    );
    expect(a.rows[0].actor_role).toBe('SYSTEM');
  });

  it('(b) worker DOWN: lazy repair on read expires the hold (plot + booking)', async () => {
    const { bookingId, plotId } = await makeDueBooking();
    // No sweeper run. Read the plot → lazy repair must fix it.
    const plot = await catalog.getPlot(plotId);
    expect(plot.status).toBe('AVAILABLE');
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('EXPIRED');
  });

  it('(b2) worker DOWN: lazy repair also fires via the map read', async () => {
    const { bookingId } = await makeDueBooking();
    const pr = await db(app).query(
      `SELECT project_id FROM plots ORDER BY plot_number LIMIT 1`,
    );
    await catalog.getProjectMap(pr.rows[0].project_id);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('EXPIRED');
  });

  it('(c) expires_at is FROZEN: changing global_hold_minutes does not move a live hold', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.block(userId, plotId, randomUUID());
    const before = r.expires_at;

    // Change config, bust cache.
    await db(app).query(`UPDATE global_settings SET value='60' WHERE key='global_hold_minutes'`);
    app.get(ConfigService).invalidate();

    const after = await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [
      r.booking_id,
    ]);
    expect(new Date(after.rows[0].expires_at).toISOString()).toBe(before);

    // restore
    await db(app).query(`UPDATE global_settings SET value='1440' WHERE key='global_hold_minutes'`);
    app.get(ConfigService).invalidate();
  });

  it('(d) sweeper and lazy repair racing → exactly one EXPIRED transition + one audit row', async () => {
    const { bookingId } = await makeDueBooking();
    await Promise.all([expiry.sweepOnce(), expiry.repairBooking(bookingId), expiry.sweepOnce()]);
    const a = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='booking.expire' AND entity_id=$1`,
      [bookingId],
    );
    expect(a.rows[0].n).toBe(1);
  });

  it('(e) paid at the buzzer: due-but-unexpired booking, sweeper does NOT touch a BOOKED one', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.block(userId, plotId, randomUUID());
    // Simulate the webhook having confirmed it right at expiry.
    await db(app).query(
      `UPDATE bookings SET status='BOOKED', confirmed_at=now(),
              expires_at=now() - interval '1 second' WHERE id=$1`,
      [r.booking_id],
    );
    await db(app).query(`UPDATE plots SET status='BOOKED' WHERE id=$1`, [plotId]);
    const n = await expiry.sweepOnce();
    expect(n).toBe(0);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [r.booking_id]);
    expect(b.rows[0].status).toBe('BOOKED');
  });
});
