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
import { ExpiryService } from '../src/modules/booking/expiry.service';
import { ConfigService } from '../src/common/config/config.service';
import { CatalogReadService } from '../src/modules/catalog/catalog-read.service';

/**
 * TP-P §2 — two-phase expiry (Invariants 5′, 6). OTP-window and decision-window lapses each →
 * EXPIRED + plot AVAILABLE; on the decision window the pending approval auto-WITHDRAWs.
 * Worker-down (lazy-repair) is the release gate; settings changes never move a live deadline.
 */
describe('TP-P §2 two-phase expiry', () => {
  let app: INestApplication;
  let booking: BookingService;
  let reservations: ReservationService;
  let expiry: ExpiryService;
  let catalog: CatalogReadService;

  beforeAll(async () => {
    app = await makeApp();
    booking = app.get(BookingService);
    reservations = app.get(ReservationService);
    expiry = app.get(ExpiryService);
    catalog = app.get(CatalogReadService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  /** A fresh PENDING_CONFIRMATION reservation, then force its OTP window into the past. */
  async function makeDueOtpReservation() {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    await db(app).query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [r.booking_id],
    );
    return { bookingId: r.booking_id, plotId, userId };
  }

  /** Reserve → confirm (using the returned dev_otp) → PENDING_APPROVAL. */
  async function makeConfirmedReservation() {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    await reservations.confirm(r.booking_id, r.challenge_id, r.dev_otp!, { id: userId });
    return { bookingId: r.booking_id, plotId, userId };
  }

  // ---- (a) OTP window ----
  it('(a) sweeper: OTP window lapses → EXPIRED + plot AVAILABLE + SYSTEM audit', async () => {
    const { bookingId, plotId } = await makeDueOtpReservation();
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

  it('(a) worker DOWN: lazy repair on plot read expires the OTP window', async () => {
    const { bookingId, plotId } = await makeDueOtpReservation();
    const plot = await catalog.getPlot(plotId);
    expect(plot.status).toBe('AVAILABLE');
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('EXPIRED');
  });

  // ---- (b) decision window + auto-withdraw ----
  it('(b) decision window lapses → EXPIRED + plot AVAILABLE + approval auto-WITHDRAWN', async () => {
    const { bookingId, plotId } = await makeConfirmedReservation();
    // Sanity: it is PENDING_APPROVAL with a PENDING approval.
    const before = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(before.rows[0].status).toBe('PENDING_APPROVAL');

    await db(app).query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [bookingId],
    );
    const n = await expiry.sweepOnce();
    expect(n).toBe(1);

    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('EXPIRED');
    const p = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId]);
    expect(p.rows[0].status).toBe('AVAILABLE');
    const ap = await db(app).query(
      `SELECT status, decision_note, decided_by FROM approvals
         WHERE entity_type='booking' AND entity_id=$1`,
      [bookingId],
    );
    expect(ap.rows[0].status).toBe('WITHDRAWN');
    expect(ap.rows[0].decision_note).toBe('auto-expired');
    expect(ap.rows[0].decided_by).toBeNull();
  });

  // ---- (c) live deadline frozen ----
  it('(c) FROZEN: changing reserve_otp_minutes does not move a live reservation deadline', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    const before = r.expires_at;

    await db(app).query(`UPDATE global_settings SET value='60' WHERE key='reserve_otp_minutes'`);
    app.get(ConfigService).invalidate();

    const after = await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [
      r.booking_id,
    ]);
    expect(new Date(after.rows[0].expires_at).toISOString()).toBe(before);

    await db(app).query(`DELETE FROM global_settings WHERE key='reserve_otp_minutes'`);
    app.get(ConfigService).invalidate();
  });

  // ---- (d) race → exactly one transition ----
  it('(d) sweeper and lazy repair racing → exactly one EXPIRED transition + one audit row', async () => {
    const { bookingId } = await makeDueOtpReservation();
    await Promise.all([expiry.sweepOnce(), expiry.repairBooking(bookingId), expiry.sweepOnce()]);
    const a = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='booking.expire' AND entity_id=$1`,
      [bookingId],
    );
    expect(a.rows[0].n).toBe(1);
  });

  // ---- (e) RESERVED is terminal for the sweeper ----
  it('(e) sweeper does NOT touch a RESERVED booking even if due', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    await db(app).query(
      `UPDATE bookings SET status='RESERVED', expires_at=now() - interval '1 second' WHERE id=$1`,
      [r.booking_id],
    );
    await db(app).query(`UPDATE plots SET status='RESERVED' WHERE id=$1`, [plotId]);
    const n = await expiry.sweepOnce();
    expect(n).toBe(0);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [r.booking_id]);
    expect(b.rows[0].status).toBe('RESERVED');
  });

  // ---- dormant BLOCKED fixtures must NOT be swept ----
  it('dormant BLOCKED booking is NOT swept (status filter excludes it)', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    await db(app).query(
      `INSERT INTO bookings (plot_id, user_id, status, total_price_paise, hold_minutes,
         expires_at, idempotency_key)
       VALUES ($1,$2,'BLOCKED',100,1440, now() - interval '1 minute', $3)`,
      [plotId, userId, randomUUID()],
    );
    await db(app).query(`UPDATE plots SET status='BLOCKED' WHERE id=$1`, [plotId]);
    const n = await expiry.sweepOnce();
    expect(n).toBe(0);
    const b = await db(app).query(
      `SELECT status FROM bookings WHERE plot_id=$1 AND status='BLOCKED'`,
      [plotId],
    );
    expect(b.rows[0].status).toBe('BLOCKED');
  });
});
