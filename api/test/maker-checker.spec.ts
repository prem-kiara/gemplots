import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { makeApp, db, resetDynamic, firstPlotId, closeAdminPool } from './harness';
import { BookingService } from '../src/modules/booking/booking.service';
import { ReservationService } from '../src/modules/booking/reservation.service';
import { TokenService } from '../src/modules/auth/token.service';
import { Role } from '../src/modules/auth/auth.types';

/**
 * MC §5 — the maker-checker gate for the 8 active controlled actions (P7). Self-approval (API +
 * DB CHECK), guardrail drift, double-request, apply() atomicity, per-action happy + reject paths,
 * role enforcement, and EXTEND_HOLD as the ONE sanctioned expires_at move (Invariant 5′).
 */
describe('MC §5 — maker-checker controlled actions (P7)', () => {
  let app: INestApplication;
  let http: any;
  let booking: BookingService;
  let reservations: ReservationService;
  let tokens: TokenService;
  const owner = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL_ADMIN ?? 'postgres://localhost:5432/gemplots_test',
  });

  beforeAll(async () => {
    app = await makeApp();
    http = request(app.getHttpServer());
    booking = app.get(BookingService);
    reservations = app.get(ReservationService);
    tokens = app.get(TokenService);
  });
  afterAll(async () => {
    await owner.end();
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  // --- helpers -------------------------------------------------------------

  async function adminId(email: string): Promise<string> {
    return (await db(app).query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0].id;
  }
  async function actor(email: string, role: Role): Promise<{ id: string; token: string }> {
    const id = await adminId(email);
    return { id, token: tokens.signAccess({ sub: id, role }) };
  }
  const ops = () => actor('ops@gemhousing.in', 'OPERATIONS');
  const superAdmin = () => actor('super@gemhousing.in', 'SUPER_ADMIN');
  const sales = () => actor('sales@gemhousing.in', 'SALES');
  const finance = () => actor('finance@gemhousing.in', 'FINANCE');

  async function seededProjectId(): Promise<string> {
    return (await db(app).query(`SELECT id FROM projects WHERE slug='gem-meadows'`)).rows[0].id;
  }
  async function plotByNumber(n: string): Promise<{ id: string; price: number; status: string }> {
    const r = (
      await db(app).query(`SELECT id, price_paise, status FROM plots WHERE plot_number=$1`, [n])
    ).rows[0];
    return { id: r.id, price: Number(r.price_paise), status: r.status };
  }

  function bearer(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // The seed argon2id hash (password GemHousing@Dev1) — satisfies the admin_has_password CHECK.
  const ADMIN_HASH =
    '$argon2id$v=19$m=65536,t=3,p=4$K03Y9dTV0sVMj3eVPOnYXQ$4wvFkux1kEWvoLS9MSq+IAvf94QXVRncYNPkLd2btTk';

  /** Create a second SUPER_ADMIN (with a password so the admin_has_password CHECK passes). */
  async function secondSuperAdmin(): Promise<{ id: string; token: string }> {
    const email = 'super2-' + Math.random().toString(36).slice(2, 8) + '@gemhousing.in';
    const id = (
      await owner.query(
        `INSERT INTO users (email, role, password_hash) VALUES ($1,'SUPER_ADMIN',$2) RETURNING id`,
        [email, ADMIN_HASH],
      )
    ).rows[0].id;
    return { id, token: tokens.signAccess({ sub: id, role: 'SUPER_ADMIN' }) };
  }

  let custSeq = 0;
  /** Reserve → confirm → PENDING_APPROVAL. Returns ids. Uses a unique customer per call. */
  async function reserveAndConfirm(plotNumber?: string) {
    const plotId = plotNumber ? (await plotByNumber(plotNumber)).id : await firstPlotId(app);
    const email = `mc-cust${custSeq++}@test.gemhousing.in`;
    const userId = (
      await db(app).query(`INSERT INTO users (email, role) VALUES ($1,'CUSTOMER') RETURNING id`, [email])
    ).rows[0].id;
    const r = await booking.reserve(userId, plotId, randomUUID());
    const conf = await reservations.confirm(r.booking_id, r.challenge_id, r.dev_otp!, { id: userId });
    return { userId, plotId, bookingId: r.booking_id, approvalId: conf.approval_id };
  }

  /**
   * Create a fresh DRAFT project (owner conn) with 1 plot + an active site map + a geometry, so
   * PUBLISH_PROJECT guardrails all pass. Returns {projectId, plotId}.
   */
  async function makeDraftProject(): Promise<{ projectId: string; plotId: string }> {
    const seller = (await owner.query(`SELECT id FROM sellers ORDER BY created_at LIMIT 1`)).rows[0];
    const slug = 'p7-draft-' + Math.random().toString(36).slice(2, 8);
    const project = (
      await owner.query(
        `INSERT INTO projects (seller_id, name, slug, status, rera_registered, max_advance_percentage)
         VALUES ($1,$2,$3,'DRAFT',false,10.00) RETURNING id`,
        [seller.id, 'P7 Draft ' + slug, slug],
      )
    ).rows[0];
    const plot = (
      await owner.query(
        `INSERT INTO plots (project_id, plot_number, area_sqft, price_paise, status)
         VALUES ($1,'D-01',1000,100000000,'AVAILABLE') RETURNING id`,
        [project.id],
      )
    ).rows[0];
    const map = (
      await owner.query(
        `INSERT INTO site_maps (project_id, version, image_key, width_px, height_px, is_active)
         VALUES ($1,1,'p7/draft.svg',1000,1000,true) RETURNING id`,
        [project.id],
      )
    ).rows[0];
    await owner.query(
      `INSERT INTO plot_geometries (site_map_id, plot_id, polygon, centroid)
       VALUES ($1,$2,'[[0.1,0.1],[0.3,0.1],[0.3,0.3],[0.1,0.3]]','[0.2,0.2]')`,
      [map.id, plot.id],
    );
    return { projectId: project.id, plotId: plot.id };
  }
  // Clean up any DRAFT projects we spun up (resetDynamic keeps only gem-meadows deletion by slug;
  // it already deletes non-gem-meadows projects, so nothing extra needed here).

  async function pendingApproval(action: string, entityId: string) {
    return (
      await db(app).query(
        `SELECT * FROM approvals WHERE action=$1 AND entity_id=$2 AND status='PENDING'`,
        [action, entityId],
      )
    ).rows[0];
  }

  // === MC §5 gate tests ====================================================

  it('self-approval → 409 at API AND the DB CHECK rejects decided_by=requested_by', async () => {
    const plot = await plotByNumber('P-04');
    const o = await ops();
    // ops files a price change (maker OPERATIONS).
    const res = await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: plot.price + 1_000_000 })
      .expect(202);
    const approvalId = res.body.approval_id;

    // ops (the maker) tries to approve → SELF_APPROVAL_FORBIDDEN (approver roles include OPERATIONS).
    await http
      .post(`/v1/admin/approvals/${approvalId}/approve`)
      .set(bearer(o.token))
      .send({})
      .expect(409)
      .expect((r: any) => expect(r.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN'));

    // DB CHECK backstop: a direct-SQL self-decision is rejected.
    await expect(
      db(app).query(`UPDATE approvals SET decided_by=$2 WHERE id=$1`, [approvalId, o.id]),
    ).rejects.toThrow(/maker_is_not_checker/i);

    // Price unchanged.
    const after = await plotByNumber('P-04');
    expect(after.price).toBe(plot.price);
  });

  it('guardrail drift: request price on AVAILABLE plot, then plot goes ON_HOLD → approve GUARDRAIL_FAILED, still PENDING, price unchanged', async () => {
    const plot = await plotByNumber('P-05');
    const o = await ops();
    const sup = await superAdmin();
    const res = await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: plot.price + 1_000_000 })
      .expect(202);
    const approvalId = res.body.approval_id;

    // Drift: put the plot ON_HOLD (SQL) — no repricing under an active hold.
    await owner.query(`UPDATE plots SET status='ON_HOLD' WHERE id=$1`, [plot.id]);

    await http
      .post(`/v1/admin/approvals/${approvalId}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(409)
      .expect((r: any) => expect(r.body.error.code).toBe('GUARDRAIL_FAILED'));

    const ap = await db(app).query(`SELECT status FROM approvals WHERE id=$1`, [approvalId]);
    expect(ap.rows[0].status).toBe('PENDING');
    const after = (await db(app).query(`SELECT price_paise FROM plots WHERE id=$1`, [plot.id])).rows[0];
    expect(Number(after.price_paise)).toBe(plot.price);
  });

  it('double-request same (action,entity) → 409 PENDING_APPROVAL_EXISTS', async () => {
    const plot = await plotByNumber('P-06');
    const o = await ops();
    await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: plot.price + 1_000_000 })
      .expect(202);
    await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: plot.price + 2_000_000 })
      .expect(409)
      .expect((r: any) => expect(r.body.error.code).toBe('PENDING_APPROVAL_EXISTS'));
  });

  it('apply() atomicity: an apply that throws mid-TX leaves the approval PENDING + entity unchanged', async () => {
    // UPDATE_GLOBAL_SETTING that passes validate() but we corrupt the row so the apply UPDATE
    // targets a key we then rename — force the apply audit to fail by revoking? Simpler + robust:
    // request BULK_PRICE_UPDATE over two plots, then flip the 2nd to ON_HOLD after guardrails pass
    // at approval read but before apply re-guards it in-TX. Since guardrails re-run just before the
    // TX, we instead drift AFTER the guardrail read by racing is hard; use a deterministic induced
    // failure: bulk over [good, bogus-uuid] where the bogus id passes request-time count only if...
    // Deterministic approach: craft a BULK request whose apply throws because one plot becomes held.
    const projectId = await seededProjectId();
    const a = await plotByNumber('P-07');
    const b = await plotByNumber('P-08');
    const o = await ops();
    const sup = await superAdmin();

    const res = await http
      .post(`/v1/admin/projects/${projectId}/bulk-price`)
      .set(bearer(o.token))
      .send({
        items: [
          { plot_id: a.id, new_price_paise: a.price + 500_000 },
          { plot_id: b.id, new_price_paise: b.price + 500_000 },
        ],
      })
      .expect(202);
    const approvalId = res.body.approval_id;

    // To isolate apply() atomicity (not the guardrail path): stub the handler's validate() to pass
    // so the re-check at approval time succeeds, then make apply() throw by flipping plot b to SOLD
    // (apply re-guards each plot in-TX and throws). The whole batch — including plot a's UPDATE and
    // the approval flip — must roll back, leaving the approval PENDING and plot a's price unchanged.
    const svc: any = app.get(
      (await import('../src/modules/approval/approval.service')).ApprovalService,
    );
    const handler = svc.handler('BULK_PRICE_UPDATE');
    const origValidate = handler.validate.bind(handler);
    handler.validate = async () => [{ name: 'stub', ok: true, detail: 'forced pass' }];
    await owner.query(`UPDATE plots SET status='SOLD' WHERE id=$1`, [b.id]); // apply() re-guard throws

    try {
      await http
        .post(`/v1/admin/approvals/${approvalId}/approve`)
        .set(bearer(sup.token))
        .send({})
        .expect((r: any) => expect(r.status).toBeGreaterThanOrEqual(400));
    } finally {
      handler.validate = origValidate;
      await owner.query(`UPDATE plots SET status='AVAILABLE' WHERE id=$1`, [b.id]);
    }

    // Approval still PENDING; the first plot's price was NOT committed (all-or-nothing rollback).
    const ap = await db(app).query(`SELECT status FROM approvals WHERE id=$1`, [approvalId]);
    expect(ap.rows[0].status).toBe('PENDING');
    const aAfter = await plotByNumber('P-07');
    expect(aAfter.price).toBe(a.price);
  });

  // --- per-action happy path (request → approve applies) + reject (unchanged) ---

  it('PUBLISH_PROJECT end-to-end: DRAFT → request publish → approve as super → PUBLISHED + visible publicly', async () => {
    const { projectId } = await makeDraftProject();
    const o = await ops();
    const sup = await superAdmin();

    const res = await http
      .post(`/v1/admin/projects/${projectId}/publish`)
      .set(bearer(o.token))
      .send({ target: 'PUBLISHED' })
      .expect(202);
    expect(res.body.status).toBe('PENDING');
    // Maker endpoint must NOT mutate.
    expect((await db(app).query(`SELECT status FROM projects WHERE id=$1`, [projectId])).rows[0].status).toBe('DRAFT');

    await http
      .post(`/v1/admin/approvals/${res.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(200);

    expect((await db(app).query(`SELECT status FROM projects WHERE id=$1`, [projectId])).rows[0].status).toBe('PUBLISHED');
    // Domain audit row + APPROVED approval.
    const audit = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='project.status_change' AND entity_id=$1`,
      [projectId],
    );
    expect(audit.rows[0].n).toBe(1);
    // Appears in the public projects list.
    const pub = await http.get(`/v1/projects`).expect(200);
    const ids = (pub.body.items ?? pub.body).map((p: any) => p.id);
    expect(ids).toContain(projectId);
  });

  it('PUBLISH_PROJECT reject leaves the project DRAFT', async () => {
    const { projectId } = await makeDraftProject();
    const o = await ops();
    const sup = await superAdmin();
    const res = await http
      .post(`/v1/admin/projects/${projectId}/publish`)
      .set(bearer(o.token))
      .send({ target: 'PUBLISHED' })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${res.body.approval_id}/reject`)
      .set(bearer(sup.token))
      .send({ note: 'not yet' })
      .expect(200);
    expect((await db(app).query(`SELECT status FROM projects WHERE id=$1`, [projectId])).rows[0].status).toBe('DRAFT');
  });

  it('UPDATE_PLOT_PRICE approve applies; reject leaves unchanged', async () => {
    const plot = await plotByNumber('P-09');
    const o = await ops();
    const sup = await superAdmin();
    const newPrice = plot.price + 1_000_000;

    const req1 = await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: newPrice })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req1.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(200);
    expect((await plotByNumber('P-09')).price).toBe(newPrice);
    const audit = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='plot.price_update' AND entity_id=$1`,
      [plot.id],
    );
    expect(audit.rows[0].n).toBe(1);

    // reject leaves unchanged
    const req2 = await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: newPrice + 500_000 })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req2.body.approval_id}/reject`)
      .set(bearer(sup.token))
      .send({ note: 'no' })
      .expect(200);
    expect((await plotByNumber('P-09')).price).toBe(newPrice);
  });

  it('FORCE_PLOT_STATUS approve applies (AVAILABLE→WITHDRAWN); reject unchanged', async () => {
    const plot = await plotByNumber('P-10');
    const o = await ops();
    const sup = await superAdmin();
    const req1 = await http
      .post(`/v1/admin/plots/${plot.id}/force-status`)
      .set(bearer(o.token))
      .send({ new_status: 'WITHDRAWN', note: 'defect' })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req1.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(200);
    expect((await plotByNumber('P-10')).status).toBe('WITHDRAWN');

    // reject: request bringing it back, then reject → stays WITHDRAWN
    const req2 = await http
      .post(`/v1/admin/plots/${plot.id}/force-status`)
      .set(bearer(o.token))
      .send({ new_status: 'AVAILABLE' })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req2.body.approval_id}/reject`)
      .set(bearer(sup.token))
      .send({ note: 'keep withdrawn' })
      .expect(200);
    expect((await plotByNumber('P-10')).status).toBe('WITHDRAWN');
  });

  it('CANCEL_BOOKING approve → CANCELLED + plot AVAILABLE + email + feeds; reject unchanged', async () => {
    const { plotId, bookingId } = await reserveAndConfirm('P-11');
    const s = await sales();
    const sup = await superAdmin();
    const req = await http
      .post(`/v1/admin/bookings/${bookingId}/cancel`)
      .set(bearer(s.token))
      .send({ note: 'customer withdrew' })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(200);
    expect((await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId])).rows[0].status).toBe('CANCELLED');
    expect((await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId])).rows[0].status).toBe('AVAILABLE');
    const email = await db(app).query(
      `SELECT count(*)::int n FROM emails_outbox WHERE template='booking_cancelled'`,
    );
    expect(email.rows[0].n).toBe(1);
    const feeds = await db(app).query(`SELECT count(*)::int n FROM portal_notifications WHERE type='BOOKING_CANCELLED'`);
    expect(feeds.rows[0].n).toBeGreaterThanOrEqual(1);

    // reject path: new booking, cancel-request, reject → still active.
    const r2 = await reserveAndConfirm('P-12');
    const req2 = await http
      .post(`/v1/admin/bookings/${r2.bookingId}/cancel`)
      .set(bearer(s.token))
      .send({ note: 'maybe' })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req2.body.approval_id}/reject`)
      .set(bearer(sup.token))
      .send({ note: 'keep it' })
      .expect(200);
    expect((await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [r2.bookingId])).rows[0].status).toBe('PENDING_APPROVAL');
  });

  it('EXTEND_HOLD moves expires_at by exactly extra_minutes; a config change does NOT (Invariant 5′)', async () => {
    const { bookingId } = await reserveAndConfirm('P-01');
    const before = new Date(
      (await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [bookingId])).rows[0].expires_at,
    );
    const s = await sales();
    const o = await ops();
    const extra = 120;
    const req = await http
      .post(`/v1/admin/bookings/${bookingId}/extend-hold`)
      .set(bearer(s.token))
      .send({ extra_minutes: extra })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(o.token))
      .send({})
      .expect(200);
    const after = new Date(
      (await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [bookingId])).rows[0].expires_at,
    );
    expect(Math.round((after.getTime() - before.getTime()) / 60000)).toBe(extra);

    // Invariant 5′: change reserve_otp_minutes (config) → the live deadline does NOT move.
    // maker SUPER_ADMIN, approver a DIFFERENT SUPER_ADMIN.
    const sup = await superAdmin();
    const super2 = await secondSuperAdmin();
    const setReq = await http
      .post(`/v1/admin/settings`)
      .set(bearer(sup.token))
      .send({ key: 'reserve_otp_minutes', new_value: 90 })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${setReq.body.approval_id}/approve`)
      .set(bearer(super2.token))
      .send({})
      .expect(200);
    const afterCfg = new Date(
      (await db(app).query(`SELECT expires_at FROM bookings WHERE id=$1`, [bookingId])).rows[0].expires_at,
    );
    expect(afterCfg.getTime()).toBe(after.getTime()); // live deadline untouched by config
    // reset the setting (the extra super admin has a random email + is referenced by its approval,
    // so it is left in place; resetDynamic truncates approvals before the next test).
    await owner.query(`UPDATE global_settings SET value='30' WHERE key='reserve_otp_minutes'`);
  });

  it('UPDATE_ADVANCE_CAP approve applies; reject unchanged', async () => {
    const projectId = await seededProjectId();
    const before = Number(
      (await db(app).query(`SELECT max_advance_percentage FROM projects WHERE id=$1`, [projectId])).rows[0].max_advance_percentage,
    );
    const o = await ops();
    const sup = await superAdmin();
    // gem-meadows is rera_registered → ceiling 10.
    const req = await http
      .post(`/v1/admin/projects/${projectId}/advance-cap`)
      .set(bearer(o.token))
      .send({ new_percentage: 8 })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(200);
    expect(Number((await db(app).query(`SELECT max_advance_percentage FROM projects WHERE id=$1`, [projectId])).rows[0].max_advance_percentage)).toBe(8);

    const req2 = await http
      .post(`/v1/admin/projects/${projectId}/advance-cap`)
      .set(bearer(o.token))
      .send({ new_percentage: 5 })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req2.body.approval_id}/reject`)
      .set(bearer(sup.token))
      .send({ note: 'no' })
      .expect(200);
    expect(Number((await db(app).query(`SELECT max_advance_percentage FROM projects WHERE id=$1`, [projectId])).rows[0].max_advance_percentage)).toBe(8);
    // reset to original so it doesn't leak.
    await owner.query(`UPDATE projects SET max_advance_percentage=$2 WHERE id=$1`, [projectId, before]);
  });

  it('BULK_PRICE_UPDATE approve applies to all; reject unchanged', async () => {
    const projectId = await seededProjectId();
    const a = await plotByNumber('P-02');
    const b = await plotByNumber('P-03');
    const o = await ops();
    const sup = await superAdmin();
    const req = await http
      .post(`/v1/admin/projects/${projectId}/bulk-price`)
      .set(bearer(o.token))
      .send({
        items: [
          { plot_id: a.id, new_price_paise: a.price + 1_000_000 },
          { plot_id: b.id, new_price_paise: b.price + 1_000_000 },
        ],
      })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(200);
    expect((await plotByNumber('P-02')).price).toBe(a.price + 1_000_000);
    expect((await plotByNumber('P-03')).price).toBe(b.price + 1_000_000);
  });

  it('UPDATE_GLOBAL_SETTING approve applies + invalidates cache; different SUPER_ADMIN checker required', async () => {
    const sup = await superAdmin();
    const super2 = await secondSuperAdmin();

    const req = await http
      .post(`/v1/admin/settings`)
      .set(bearer(sup.token))
      .send({ key: 'max_active_holds_per_user', new_value: 4 })
      .expect(202);
    // maker cannot approve own even though approver role is also SUPER_ADMIN.
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(sup.token))
      .send({})
      .expect(409)
      .expect((r: any) => expect(r.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN'));
    // a different super admin approves.
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(super2.token))
      .send({})
      .expect(200);
    const val = (await db(app).query(`SELECT value FROM global_settings WHERE key='max_active_holds_per_user'`)).rows[0].value;
    expect(Number(val)).toBe(4);

    await owner.query(`UPDATE global_settings SET value='2' WHERE key='max_active_holds_per_user'`);
  });

  it('UPDATE_GLOBAL_SETTING guardrail: unknown key → 409 at request', async () => {
    const sup = await superAdmin();
    await http
      .post(`/v1/admin/settings`)
      .set(bearer(sup.token))
      .send({ key: 'not_a_real_key', new_value: 5 })
      .expect(409)
      .expect((r: any) => expect(r.body.error.code).toBe('GUARDRAIL_FAILED'));
  });

  // --- role enforcement ----------------------------------------------------

  it('role: a non-maker role requesting an action → 403', async () => {
    const plot = await plotByNumber('P-04');
    // SALES cannot request FORCE_PLOT_STATUS (maker OPERATIONS only) — route roles guard 403.
    const s = await sales();
    await http
      .post(`/v1/admin/plots/${plot.id}/force-status`)
      .set(bearer(s.token))
      .send({ new_status: 'WITHDRAWN' })
      .expect(403);
  });

  it('role: an approver not in approverRoles → 403 (FINANCE cannot approve UPDATE_PLOT_PRICE)', async () => {
    const plot = await plotByNumber('P-05');
    const o = await ops();
    const fin = await finance();
    const req = await http
      .post(`/v1/admin/plots/${plot.id}/price`)
      .set(bearer(o.token))
      .send({ new_price_paise: plot.price + 1_000_000 })
      .expect(202);
    // FINANCE is allowed at the route (union) but the handler approverRoles = SUPER_ADMIN/OPERATIONS.
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(fin.token))
      .send({})
      .expect(403);
  });

  it('role: FINANCE CAN approve CANCEL_BOOKING (approverRoles include FINANCE)', async () => {
    const { bookingId } = await reserveAndConfirm('P-06');
    const s = await sales();
    const fin = await finance();
    const req = await http
      .post(`/v1/admin/bookings/${bookingId}/cancel`)
      .set(bearer(s.token))
      .send({ note: 'ok' })
      .expect(202);
    await http
      .post(`/v1/admin/approvals/${req.body.approval_id}/approve`)
      .set(bearer(fin.token))
      .send({})
      .expect(200);
    expect((await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [bookingId])).rows[0].status).toBe('CANCELLED');
  });
});
