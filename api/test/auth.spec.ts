import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { makeApp, db, resetDynamic, closeAdminPool } from './harness';

/** TP §3-auth: OTP happy path, rate limits, refresh rotation + reuse, RBAC. */
describe('TP §3 auth', () => {
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

  const PHONE = '+919812345678';

  it('OTP request → verify creates a customer and returns tokens', async () => {
    // Seed a deterministic challenge we control (bypasses SMS; mirrors OtpService hashing).
    const crypto = require('crypto');
    const otp = '123456';
    const hash = crypto.createHash('sha256').update(otp + 'test-pepper').digest('hex');
    const ch = await db(app).query(
      `INSERT INTO otp_challenges (phone, otp_hash, expires_at)
       VALUES ($1,$2, now() + interval '5 min') RETURNING id`,
      [PHONE, hash],
    );
    const res = await http
      .post('/v1/auth/otp/verify')
      .send({ challenge_id: ch.rows[0].id, phone: PHONE, otp })
      .expect(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.user.role).toBe('CUSTOMER');
  });

  it('wrong OTP increments attempts and returns OTP_INVALID', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('999999test-pepper').digest('hex');
    const ch = await db(app).query(
      `INSERT INTO otp_challenges (phone, otp_hash, expires_at)
       VALUES ($1,$2, now() + interval '5 min') RETURNING id`,
      [PHONE, hash],
    );
    const res = await http
      .post('/v1/auth/otp/verify')
      .send({ challenge_id: ch.rows[0].id, phone: PHONE, otp: '000000' })
      .expect(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    const after = await db(app).query(`SELECT attempts FROM otp_challenges WHERE id=$1`, [
      ch.rows[0].id,
    ]);
    expect(after.rows[0].attempts).toBe(1);
  });

  it('OTP send rate limit: 4th request in window → OTP_RATE_LIMITED', async () => {
    await http.post('/v1/auth/otp/request').send({ phone: PHONE }).expect(200);
    await http.post('/v1/auth/otp/request').send({ phone: PHONE }).expect(200);
    await http.post('/v1/auth/otp/request').send({ phone: PHONE }).expect(200);
    const res = await http.post('/v1/auth/otp/request').send({ phone: PHONE }).expect(429);
    expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
  });

  it('admin login with seed credentials works; wrong password → INVALID_CREDENTIALS', async () => {
    const ok = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@dev.dhanam', password: 'Dhanam@Dev1' })
      .expect(200);
    expect(ok.body.user.role).toBe('OPERATIONS');
    const bad = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@dev.dhanam', password: 'wrong' })
      .expect(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh rotates; reusing an old refresh token → REFRESH_REUSED and chain revoked', async () => {
    const login = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'sales@dev.dhanam', password: 'Dhanam@Dev1' })
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

  it('RBAC: AUDITOR (read-only) cannot create a project; OPERATIONS can', async () => {
    const auditor = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'auditor@dev.dhanam', password: 'Dhanam@Dev1' })
      .expect(200);
    await http
      .post('/v1/admin/projects')
      .set('authorization', `Bearer ${auditor.body.access_token}`)
      .send({ name: 'Nope' })
      .expect(403);

    const ops = await http
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@dev.dhanam', password: 'Dhanam@Dev1' })
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
