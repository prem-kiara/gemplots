import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { makeApp, db, resetDynamic, closeAdminPool } from './harness';

/**
 * TP §3-auth (email pivot, 08 §9): OTP happy path, wrong-OTP attempts, send rate limit, admin
 * login, refresh rotation + reuse chain, RBAC, missing bearer — plus outbox assertions and the
 * dev_otp double-gate (Invariant 12 / TP-P §4).
 */
describe('TP §3 auth (email)', () => {
  let app: INestApplication;
  let http: any;

  beforeAll(async () => {
    app = await makeApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  const EMAIL = 'buyer@test.gemhousing.in';

  it('OTP request → verify creates a customer and returns tokens', async () => {
    // Seed a deterministic LOGIN challenge we control (mirrors OtpService hashing/pepper).
    const crypto = require('crypto');
    const otp = '123456';
    const hash = crypto.createHash('sha256').update(otp + 'test-pepper').digest('hex');
    const ch = await db(app).query(
      `INSERT INTO otp_challenges (email, otp_hash, purpose, expires_at)
       VALUES ($1,$2,'LOGIN', now() + interval '5 min') RETURNING id`,
      [EMAIL, hash],
    );
    const res = await http
      .post('/v1/auth/otp/verify')
      .send({ challenge_id: ch.rows[0].id, email: EMAIL, otp })
      .expect(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.user.role).toBe('CUSTOMER');
    expect(res.body.user.email).toBe(EMAIL);
  });

  it('wrong OTP increments attempts and returns OTP_INVALID', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('999999test-pepper').digest('hex');
    const ch = await db(app).query(
      `INSERT INTO otp_challenges (email, otp_hash, purpose, expires_at)
       VALUES ($1,$2,'LOGIN', now() + interval '5 min') RETURNING id`,
      [EMAIL, hash],
    );
    const res = await http
      .post('/v1/auth/otp/verify')
      .send({ challenge_id: ch.rows[0].id, email: EMAIL, otp: '000000' })
      .expect(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    const after = await db(app).query(`SELECT attempts FROM otp_challenges WHERE id=$1`, [
      ch.rows[0].id,
    ]);
    expect(after.rows[0].attempts).toBe(1);
  });

  it('OTP send rate limit: 4th request in window → OTP_RATE_LIMITED', async () => {
    await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
    await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
    await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
    const res = await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(429);
    expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
  });

  it('otp/request writes an emails_outbox row (login_otp, LOGGED) — console driver default', async () => {
    await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
    const rows = await db(app).query(
      `SELECT template, status, subject FROM emails_outbox WHERE to_email=$1`,
      [EMAIL],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].template).toBe('login_otp');
    expect(rows.rows[0].status).toBe('LOGGED');
  });

  it('dev_otp is present under test env (console + non-production)', async () => {
    const res = await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
    expect(res.body.dev_otp).toMatch(/^\d{6}$/);
    // and it actually verifies the challenge
    const ok = await http
      .post('/v1/auth/otp/verify')
      .send({ challenge_id: res.body.challenge_id, email: EMAIL, otp: res.body.dev_otp })
      .expect(200);
    expect(ok.body.access_token).toBeTruthy();
  });

  it('dev_otp is ABSENT when NODE_ENV=production (Invariant 12 / TP-P §4)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
      expect(res.body.dev_otp).toBeUndefined();
      expect(res.body.challenge_id).toBeTruthy();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('admin login with seed credentials works; wrong password → INVALID_CREDENTIALS', async () => {
    const ok = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@gemhousing.in', password: 'GemHousing@Dev1' })
      .expect(200);
    expect(ok.body.user.role).toBe('OPERATIONS');
    const bad = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@gemhousing.in', password: 'wrong' })
      .expect(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh rotates; reusing an old refresh token → REFRESH_REUSED and chain revoked', async () => {
    const login = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'sales@gemhousing.in', password: 'GemHousing@Dev1' })
      .expect(200);
    const rt0 = login.body.refresh_token;
    const r1 = await http.post('/v1/auth/refresh').send({ refresh_token: rt0 }).expect(200);
    expect(r1.body.refresh_token).not.toBe(rt0);
    // reuse the now-revoked rt0
    const reuse = await http.post('/v1/auth/refresh').send({ refresh_token: rt0 }).expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
    // the rotated token is now also revoked (whole chain)
    await http.post('/v1/auth/refresh').send({ refresh_token: r1.body.refresh_token }).expect(401);
  });

  it('PATCH /me updates the customer profile and writes an audit row', async () => {
    // Log in a fresh customer via the dev_otp path.
    const req = await http.post('/v1/auth/otp/request').send({ email: EMAIL }).expect(200);
    const login = await http
      .post('/v1/auth/otp/verify')
      .send({ challenge_id: req.body.challenge_id, email: EMAIL, otp: req.body.dev_otp })
      .expect(200);
    const token = login.body.access_token;

    const patched = await http
      .patch('/v1/me')
      .set('authorization', `Bearer ${token}`)
      .send({ full_name: 'Test Buyer', phone: '+919812345678' })
      .expect(200);
    expect(patched.body.full_name).toBe('Test Buyer');
    expect(patched.body.phone).toBe('+919812345678');

    const audit = await db(app).query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action='user.update_profile'
         AND entity_id=$1`,
      [login.body.user.id],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('RBAC: AUDITOR (read-only) cannot create a project; OPERATIONS can', async () => {
    const auditor = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'auditor@gemhousing.in', password: 'GemHousing@Dev1' })
      .expect(200);
    await http
      .post('/v1/admin/projects')
      .set('authorization', `Bearer ${auditor.body.access_token}`)
      .send({ name: 'Nope' })
      .expect(403);

    const ops = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@gemhousing.in', password: 'GemHousing@Dev1' })
      .expect(200);
    const created = await http
      .post('/v1/admin/projects')
      .set('authorization', `Bearer ${ops.body.access_token}`)
      .send({ name: 'RBAC Test Project' })
      .expect(201);
    expect(created.body.slug).toBe('rbac-test-project'); // reset handles cleanup
  });

  it('missing bearer on a protected route → 401 UNAUTHENTICATED', async () => {
    const res = await http.get('/v1/me/bookings').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
