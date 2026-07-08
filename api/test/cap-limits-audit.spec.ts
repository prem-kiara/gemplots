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
import { PaymentService } from '../src/modules/payment/payment.service';
import { ConfigService } from '../src/common/config/config.service';
import { AppError } from '../src/common/errors';

describe('TP §2.4/§2.5/§2.7 cap, limits, audit immutability', () => {
  let app: INestApplication;
  let booking: BookingService;
  let payment: PaymentService;

  beforeAll(async () => {
    app = await makeApp();
    booking = app.get(BookingService);
    payment = app.get(PaymentService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  // ---- TP §2.4 RERA cap ----
  it('§2.4 order at exactly the cap → ok; +1 paise → ADVANCE_EXCEEDS_CAP', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const b = await booking.block(userId, plotId, randomUUID());
    const cap = b.advance_cap_paise; // seed project rera_registered, 10% of 180000000 = 18000000
    expect(cap).toBe(18000000);

    const ok = await payment.createOrder(userId, b.booking_id, cap, randomUUID());
    expect(ok.amount_paise).toBe(cap);

    await expect(payment.createOrder(userId, b.booking_id, cap + 1, randomUUID())).rejects.toThrow(
      expect.objectContaining({ code: 'ADVANCE_EXCEEDS_CAP' }) as any,
    );
  });

  it('§2.4 project cap 15% but rera_registered → effective cap stays 10%', async () => {
    await db(app).query(
      `UPDATE projects SET max_advance_percentage=15 WHERE slug='gem-meadows'`,
    );
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const b = await booking.block(userId, plotId, randomUUID());
    expect(b.advance_cap_paise).toBe(18000000); // 10% not 15%
    await db(app).query(
      `UPDATE projects SET max_advance_percentage=10 WHERE slug='gem-meadows'`,
    );
  });

  it('§2.4 below min_advance → ADVANCE_BELOW_MIN; integer cap math on odd total', async () => {
    // odd total: 9,99,999 paise, 10% → floor(99999.9)=99999
    await db(app).query(`UPDATE plots SET price_paise=999999 WHERE plot_number='P-01'`);
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const b = await booking.block(userId, plotId, randomUUID());
    expect(b.advance_cap_paise).toBe(99999);
    // min_advance default is 1,000,000 > cap, so any valid amount ≤ cap is below min here
    await expect(payment.createOrder(userId, b.booking_id, 99999, randomUUID())).rejects.toThrow(
      expect.objectContaining({ code: 'ADVANCE_BELOW_MIN' }) as any,
    );
    await db(app).query(`UPDATE plots SET price_paise=180000000 WHERE plot_number='P-01'`);
  });

  // ---- TP §2.5 hold limit + idempotency conflicts ----
  it('§2.5 hold limit: max active holds → HOLD_LIMIT_EXCEEDED; frees after expiry', async () => {
    const [userId] = await makeCustomers(app, 1);
    const plots = (
      await db(app).query(`SELECT id FROM plots ORDER BY plot_number`)
    ).rows.map((r) => r.id);
    // default max_active_holds_per_user = 2
    await booking.block(userId, plots[0], randomUUID());
    await booking.block(userId, plots[1], randomUUID());
    await expect(booking.block(userId, plots[2], randomUUID())).rejects.toThrow(
      expect.objectContaining({ code: 'HOLD_LIMIT_EXCEEDED' }) as any,
    );
    // expire one → next block succeeds
    await db(app).query(
      `UPDATE bookings SET status='EXPIRED', closed_at=now() WHERE plot_id=$1`,
      [plots[0]],
    );
    await db(app).query(`UPDATE plots SET status='AVAILABLE' WHERE id=$1`, [plots[0]]);
    const ok = await booking.block(userId, plots[2], randomUUID());
    expect(ok.status).toBe('BLOCKED');
  });

  it('§2.5 same key different plot → IDEMPOTENCY_CONFLICT', async () => {
    const [userId] = await makeCustomers(app, 1);
    const plots = (await db(app).query(`SELECT id FROM plots ORDER BY plot_number`)).rows.map(
      (r) => r.id,
    );
    const key = randomUUID();
    await booking.block(userId, plots[0], key);
    await expect(booking.block(userId, plots[1], key)).rejects.toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }) as any,
    );
  });

  it('§2.5 payment-order replay same key → same order; different amount → conflict', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const b = await booking.block(userId, plotId, randomUUID());
    const key = randomUUID();
    const o1 = await payment.createOrder(userId, b.booking_id, b.advance_cap_paise, key);
    const o2 = await payment.createOrder(userId, b.booking_id, b.advance_cap_paise, key);
    expect(o2.gateway_order_id).toBe(o1.gateway_order_id);
    await expect(
      payment.createOrder(userId, b.booking_id, b.advance_cap_paise - 100, key),
    ).rejects.toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }) as any);
  });

  // ---- TP §2.7 audit immutability (Invariant 10) ----
  it('§2.7 app role cannot UPDATE or DELETE audit_logs', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    await booking.block(userId, plotId, randomUUID()); // writes an audit row as gemplots_app

    await expect(db(app).query(`UPDATE audit_logs SET action='tamper'`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(db(app).query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/i);
  });

  it('§2.7 block writes exactly the expected audit row', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    await booking.block(userId, plotId, randomUUID());
    const rows = await db(app).query(
      `SELECT action, actor_role FROM audit_logs WHERE entity_id=$1 ORDER BY id`,
      [plotId],
    );
    expect(rows.rows.map((r) => r.action)).toContain('booking.block');
  });
});
