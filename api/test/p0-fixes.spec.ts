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
import { TokenService } from '../src/modules/auth/token.service';
import { AppError } from '../src/common/errors';

/** Regression tests for the slice-P0 review fixes (docs/09 F2–F4). */
describe('P0 fixes', () => {
  let app: INestApplication;
  let http: any;
  let tokens: TokenService;
  let booking: BookingService;

  beforeAll(async () => {
    app = await makeApp();
    http = request(app.getHttpServer());
    tokens = app.get(TokenService);
    booking = app.get(BookingService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  async function customerToken(): Promise<{ id: string; token: string }> {
    const [id] = await makeCustomers(app, 1);
    return { id, token: tokens.signAccess({ sub: id, role: 'CUSTOMER' }) };
  }
  async function opsToken(): Promise<string> {
    const id = (await db(app).query(`SELECT id FROM users WHERE email='ops@gemhousing.in'`))
      .rows[0].id;
    return tokens.signAccess({ sub: id, role: 'OPERATIONS' });
  }

  // ---- F2: plots/bulk route (Express 4 parsed :bulk as a param) ----
  it('F2: POST /admin/projects/{id}/plots/bulk works; the old :bulk path is gone', async () => {
    const token = await opsToken();
    const projectId = (await db(app).query(`SELECT id FROM projects LIMIT 1`)).rows[0].id;
    const csv = 'plot_number,area_sqft,price_inr\nBULK-1,1000,500000';

    const ok = await http
      .post(`/v1/admin/projects/${projectId}/plots/bulk?dry_run=true`)
      .set('authorization', `Bearer ${token}`)
      .set('content-type', 'application/json')
      .send({ csv })
      .expect(201);
    expect(ok.body.inserted).toBe(0); // dry run
    expect(Array.isArray(ok.body.errors)).toBe(true);

    // The old literal-colon path must no longer resolve to this handler.
    await http
      .post(`/v1/admin/projects/${projectId}/plots:bulk`)
      .set('authorization', `Bearer ${token}`)
      .send({ csv })
      .expect(404);
  });

  // ---- F3: idempotent replay must return 200, not 201 (now on /reserve) ----
  it('F3: first reserve → 201; replay with same Idempotency-Key → 200 + Idempotency-Replay header', async () => {
    const { token } = await customerToken();
    const plotId = await firstPlotId(app);
    const key = randomUUID();

    const first = await http
      .post(`/v1/plots/${plotId}/reserve`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', key)
      .expect(201);
    const bookingId = first.body.booking_id;
    expect(first.headers['idempotency-replay']).toBeUndefined();

    const replay = await http
      .post(`/v1/plots/${plotId}/reserve`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', key)
      .expect(200);
    expect(replay.headers['idempotency-replay']).toBe('true');
    expect(replay.body.booking_id).toBe(bookingId);
  });

  // ---- F4: hold-limit race — parallel reserves by one user cannot overshoot the cap ----
  it('F4: 3 parallel reserves on 3 plots by one user (max=2) → exactly 2 succeed', async () => {
    const [userId] = await makeCustomers(app, 1);
    const plots = (await db(app).query(`SELECT id FROM plots ORDER BY plot_number`)).rows.map(
      (r) => r.id,
    );
    expect(plots.length).toBeGreaterThanOrEqual(3);

    const results = await Promise.allSettled(
      plots.slice(0, 3).map((pid) => booking.reserve(userId, pid, randomUUID())),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const limited = results.filter(
      (r) => r.status === 'rejected' && (r.reason as AppError)?.code === 'HOLD_LIMIT_EXCEEDED',
    );
    expect(ok.length).toBe(2);
    expect(limited.length).toBe(1);

    const active = await db(app).query(
      `SELECT count(*)::int n FROM bookings WHERE user_id=$1
         AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')`,
      [userId],
    );
    expect(active.rows[0].n).toBe(2);
  });
});
