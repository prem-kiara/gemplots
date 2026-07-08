import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
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
import { TokenService } from '../src/modules/auth/token.service';

/**
 * TP-P §3 — Invariant 7′: a booking becomes RESERVED ONLY via an admin approval with
 * decided_by <> requested_by. No customer-facing path sets RESERVED. Full happy path + reject +
 * self-approval (API 409 + DB CHECK) + no-customer-path-to-RESERVED + guardrail drift.
 */
describe('TP-P §3 reserve flow (Invariant 7′)', () => {
  let app: INestApplication;
  let http: any;
  let booking: BookingService;
  let reservations: ReservationService;
  let tokens: TokenService;

  beforeAll(async () => {
    app = await makeApp();
    http = request(app.getHttpServer());
    booking = app.get(BookingService);
    reservations = app.get(ReservationService);
    tokens = app.get(TokenService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  async function opsAdmin(): Promise<{ id: string; token: string }> {
    const id = (await db(app).query(`SELECT id FROM users WHERE email='ops@gemhousing.in'`))
      .rows[0].id;
    return { id, token: tokens.signAccess({ sub: id, role: 'OPERATIONS' }) };
  }
  async function financeAdmin(): Promise<string> {
    const id = (await db(app).query(`SELECT id FROM users WHERE email='finance@gemhousing.in'`))
      .rows[0].id;
    return tokens.signAccess({ sub: id, role: 'FINANCE' });
  }

  /** Reserve → confirm → PENDING_APPROVAL. Returns booking + approval ids. */
  async function reserveAndConfirm() {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    expect(r.dev_otp).toBeDefined();
    const conf = await reservations.confirm(r.booking_id, r.challenge_id, r.dev_otp!, {
      id: userId,
    });
    return { userId, plotId, bookingId: r.booking_id, approvalId: conf.approval_id };
  }

  it('happy path: reserve → confirm → admin approve → booking + plot RESERVED, emails + feeds emitted', async () => {
    const { plotId, bookingId, approvalId } = await reserveAndConfirm();
    const { token } = await opsAdmin();

    // Confirm emitted the admin alert + customer receipt emails.
    const reqAdmin = await db(app).query(
      `SELECT count(*)::int n FROM emails_outbox WHERE template='reservation_requested_admin'`,
    );
    expect(reqAdmin.rows[0].n).toBe(1);

    const res = await http
      .post(`/v1/admin/approvals/${approvalId}/approve`)
      .set('authorization', `Bearer ${token}`)
      .send({ note: 'looks good' })
      .expect(200);
    expect(res.body.status).toBe('APPROVED');

    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('RESERVED');
    const p = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId]);
    expect(p.rows[0].status).toBe('RESERVED');
    const ap = await db(app).query(
      `SELECT status, decided_by, requested_by FROM approvals WHERE id=$1`,
      [approvalId],
    );
    expect(ap.rows[0].status).toBe('APPROVED');
    expect(ap.rows[0].decided_by).not.toBe(ap.rows[0].requested_by);

    const approvedEmail = await db(app).query(
      `SELECT count(*)::int n FROM emails_outbox WHERE template='reservation_approved'`,
    );
    expect(approvedEmail.rows[0].n).toBe(1);
    const feeds = await db(app).query(
      `SELECT audience FROM portal_notifications WHERE type='RESERVATION_APPROVED'`,
    );
    expect(feeds.rows.map((r) => r.audience).sort()).toEqual(['ADMIN', 'CUSTOMER']);
    // The RESERVATION_REQUESTED (reserve) and RESERVATION_CONFIRMED (confirm) feeds fired too.
    const events = await db(app).query(
      `SELECT DISTINCT type FROM portal_notifications`,
    );
    const types = events.rows.map((r) => r.type);
    expect(types).toContain('RESERVATION_REQUESTED');
    expect(types).toContain('RESERVATION_CONFIRMED');

    const audit = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs
         WHERE action='booking.reserve_approved' AND entity_id=$1`,
      [bookingId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('GET /plots/{id} exposes blocked_until (active hold expires_at) while ON_HOLD', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    // Plot is now ON_HOLD with a PENDING_CONFIRMATION booking; the read API surfaces the deadline.
    const res = await http.get(`/v1/plots/${plotId}`).expect(200);
    expect(res.body.status).toBe('ON_HOLD');
    expect(res.body.blocked_until).toBe(new Date(r.expires_at).toISOString());
  });

  it('reject path: booking → REJECTED, plot → AVAILABLE, reservation_rejected email', async () => {
    const { plotId, bookingId, approvalId } = await reserveAndConfirm();
    const { token } = await opsAdmin();

    await http
      .post(`/v1/admin/approvals/${approvalId}/reject`)
      .set('authorization', `Bearer ${token}`)
      .send({ note: 'not this time' })
      .expect(200);

    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('REJECTED');
    const p = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId]);
    expect(p.rows[0].status).toBe('AVAILABLE');
    const ap = await db(app).query(`SELECT status FROM approvals WHERE id=$1`, [approvalId]);
    expect(ap.rows[0].status).toBe('REJECTED');
    const email = await db(app).query(
      `SELECT count(*)::int n FROM emails_outbox WHERE template='reservation_rejected'`,
    );
    expect(email.rows[0].n).toBe(1);
  });

  it('reject requires a note → 400 when missing', async () => {
    const { approvalId } = await reserveAndConfirm();
    const { token } = await opsAdmin();
    await http
      .post(`/v1/admin/approvals/${approvalId}/reject`)
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });

  it('SELF-approval: API 409 SELF_APPROVAL_FORBIDDEN AND direct-SQL UPDATE violates the CHECK', async () => {
    const { bookingId, approvalId } = await reserveAndConfirm();
    const { id: opsId, token } = await opsAdmin();

    // Force requested_by to the ops admin (as if the maker were the checker).
    await db(app).query(`UPDATE approvals SET requested_by=$2 WHERE id=$1`, [approvalId, opsId]);

    await http
      .post(`/v1/admin/approvals/${approvalId}/approve`)
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(409)
      .expect((r: any) => expect(r.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN'));

    // The DB CHECK is the backstop: a direct-SQL self-decision is rejected too.
    await expect(
      db(app).query(`UPDATE approvals SET decided_by=$2 WHERE id=$1`, [approvalId, opsId]),
    ).rejects.toThrow(/maker_is_not_checker/i);

    // Booking untouched.
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('PENDING_APPROVAL');
  });

  it('NO customer path to RESERVED: polling GET /bookings/{id} never mutates status', async () => {
    const { userId, bookingId } = await reserveAndConfirm();
    const token = tokens.signAccess({ sub: userId, role: 'CUSTOMER' });
    for (let i = 0; i < 5; i++) {
      const res = await http
        .get(`/v1/bookings/${bookingId}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.status).toBe('PENDING_APPROVAL');
    }
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).toBe('PENDING_APPROVAL');
  });

  it('guardrail drift: expire the booking (SQL) then approve → 409 (guardrail/not-pending)', async () => {
    const { bookingId, approvalId } = await reserveAndConfirm();
    const { token } = await opsAdmin();

    // Drift: the decision window has passed (but no sweep ran, so booking is still PENDING_APPROVAL
    // with expires_at in the past → guardrail not_expired fails).
    await db(app).query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [bookingId],
    );

    const res = await http
      .post(`/v1/admin/approvals/${approvalId}/approve`)
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(409);
    expect(['GUARDRAIL_FAILED', 'APPROVAL_NOT_PENDING']).toContain(res.body.error.code);

    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(b.rows[0].status).not.toBe('RESERVED');
  });

  it('FINANCE cannot approve/reject RESERVE_PLOT (roles guard) but can view the list', async () => {
    const { approvalId } = await reserveAndConfirm();
    const finToken = await financeAdmin();

    await http
      .post(`/v1/admin/approvals/${approvalId}/approve`)
      .set('authorization', `Bearer ${finToken}`)
      .send({})
      .expect(403);

    await http
      .get(`/v1/admin/approvals?status=PENDING`)
      .set('authorization', `Bearer ${finToken}`)
      .expect(200)
      .expect((r: any) => expect(r.body.items.length).toBeGreaterThanOrEqual(1));
  });

  it('resend-otp: owner gets a fresh challenge; the new OTP confirms', async () => {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const token = tokens.signAccess({ sub: userId, role: 'CUSTOMER' });
    const r = await booking.reserve(userId, plotId, randomUUID());

    const resend = await http
      .post(`/v1/reservations/${r.booking_id}/resend-otp`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(resend.body.challenge_id).toBeDefined();
    expect(resend.body.dev_otp).toBeDefined();
    expect(resend.body.challenge_id).not.toBe(r.challenge_id);

    const conf = await reservations.confirm(
      r.booking_id,
      resend.body.challenge_id,
      resend.body.dev_otp,
      { id: userId },
    );
    expect(conf.status).toBe('PENDING_APPROVAL');
  });
});
