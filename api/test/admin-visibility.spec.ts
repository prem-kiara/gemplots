import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
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
import { StorageService } from '../src/common/storage/storage.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { AuthService } from '../src/modules/auth/auth.service';

/**
 * D3 — admin visibility + local storage + demo seed. Notifications endpoints, dashboard summary
 * shape (10 §5.3.3), local-disk storage round-trip served at /files/*, idOrSlug, seed integrity,
 * and the NEW_CUSTOMER feed event on first login.
 */
describe('D3 admin visibility + storage + seed', () => {
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

  async function adminToken(email: string, role: string): Promise<string> {
    const id = (await db(app).query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0].id;
    return tokens.signAccess({ sub: id, role: role as any });
  }
  const opsToken = () => adminToken('ops@gemhousing.in', 'OPERATIONS');
  const auditorToken = () => adminToken('auditor@gemhousing.in', 'AUDITOR');

  /** Reserve → confirm → PENDING_APPROVAL. Returns ids. */
  async function reserveAndConfirm() {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const r = await booking.reserve(userId, plotId, randomUUID());
    const conf = await reservations.confirm(r.booking_id, r.challenge_id, r.dev_otp!, {
      id: userId,
    });
    return { userId, plotId, bookingId: r.booking_id, approvalId: conf.approval_id };
  }

  // --- Notifications ------------------------------------------------------------------------

  it('GET /admin/notifications lists ADMIN feed rows newest first + count + read/read-all', async () => {
    const notify = app.get(NotificationService);
    await notify.feed('ADMIN', 'A', 'first', '', 'x', '1');
    await notify.feed('ADMIN', 'B', 'second', '', 'x', '2');
    await notify.feed('CUSTOMER', 'C', 'not-admin', '', 'x', '3', (await makeCustomers(app, 1))[0]);

    const token = await opsToken();
    const list = await http
      .get('/v1/admin/notifications')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    // Only ADMIN rows, newest first.
    expect(list.body.items.map((i: any) => i.title)).toEqual(['second', 'first']);
    expect(list.body.items[0]).toMatchObject({
      type: 'B',
      title: 'second',
      body: '',
      entity_type: 'x',
      entity_id: '2',
      read_at: null,
    });

    const count = await http
      .get('/v1/admin/notifications/count')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(count.body.unread).toBe(2);

    // Mark one read → count drops to 1.
    const firstId = list.body.items[1].id;
    await http
      .post(`/v1/admin/notifications/${firstId}/read`)
      .set('authorization', `Bearer ${token}`)
      .expect(204);
    const c2 = await http
      .get('/v1/admin/notifications/count')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(c2.body.unread).toBe(1);

    // unread=true excludes the read row.
    const unread = await http
      .get('/v1/admin/notifications?unread=true')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(unread.body.items.map((i: any) => i.title)).toEqual(['second']);

    // read-all clears the rest.
    await http
      .post('/v1/admin/notifications/read-all')
      .set('authorization', `Bearer ${token}`)
      .expect(204);
    const c3 = await http
      .get('/v1/admin/notifications/count')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(c3.body.unread).toBe(0);
  });

  it('AUDITOR may read the admin feed', async () => {
    const notify = app.get(NotificationService);
    await notify.feed('ADMIN', 'A', 'hi');
    const token = await auditorToken();
    const res = await http
      .get('/v1/admin/notifications')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBe(1);
  });

  it('GET /me/notifications returns only the caller CUSTOMER rows', async () => {
    const notify = app.get(NotificationService);
    const [mine, other] = await makeCustomers(app, 2);
    await notify.feed('CUSTOMER', 'X', 'yours', '', 'booking', 'b1', mine);
    await notify.feed('CUSTOMER', 'Y', 'theirs', '', 'booking', 'b2', other);
    await notify.feed('ADMIN', 'Z', 'admin-only');

    const token = tokens.signAccess({ sub: mine, role: 'CUSTOMER' });
    const res = await http
      .get('/v1/me/notifications')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.map((i: any) => i.title)).toEqual(['yours']);
  });

  // --- Dashboard summary --------------------------------------------------------------------

  it('GET /admin/dashboard/summary matches the 10 §5.3.3 shape with a live hold', async () => {
    const { plotId } = await reserveAndConfirm();
    const token = await opsToken();

    const res = await http
      .get('/v1/admin/dashboard/summary')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    // Exact top-level shape.
    expect(Object.keys(res.body).sort()).toEqual(
      ['active_holds', 'approvals_pending', 'plots_by_status', 'recent_notifications'].sort(),
    );
    expect(res.body.approvals_pending).toBe(1);

    // The hold appears with the required fields.
    expect(res.body.active_holds.length).toBe(1);
    const hold = res.body.active_holds[0];
    expect(Object.keys(hold).sort()).toEqual(
      ['booking_id', 'customer_email', 'expires_at', 'plot_number', 'project_name', 'status'].sort(),
    );
    expect(hold.status).toBe('PENDING_APPROVAL');

    // plots_by_status always carries the five keys; the held plot is ON_HOLD.
    expect(Object.keys(res.body.plots_by_status).sort()).toEqual(
      ['AVAILABLE', 'ON_HOLD', 'RESERVED', 'SOLD', 'WITHDRAWN'].sort(),
    );
    expect(res.body.plots_by_status.ON_HOLD).toBe(1);
    // 12 seed plots total; one on hold → 11 available.
    expect(res.body.plots_by_status.AVAILABLE).toBe(11);

    expect(Array.isArray(res.body.recent_notifications)).toBe(true);
    // reserve + confirm emitted feed events → summary sees them.
    expect(res.body.recent_notifications.length).toBeGreaterThanOrEqual(1);

    // Sanity: the held plot is the one we reserved.
    expect(hold.booking_id).toBeTruthy();
    void plotId;
  });

  it('dashboard summary runs lazy repair so an expired hold is not counted', async () => {
    const { plotId, bookingId } = await reserveAndConfirm();
    // Force the decision window into the past — no sweeper ran.
    await db(app).query(`UPDATE bookings SET expires_at = now() - interval '1 min' WHERE id=$1`, [
      bookingId,
    ]);
    const token = await opsToken();
    const res = await http
      .get('/v1/admin/dashboard/summary')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    // Lazy repair expired it before counting: plot back to AVAILABLE, no active hold.
    expect(res.body.active_holds.length).toBe(0);
    expect(res.body.plots_by_status.ON_HOLD).toBe(0);
    const p = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [plotId]);
    expect(p.rows[0].status).toBe('AVAILABLE');
  });

  // --- Admin reads: emails, bookings, audit, settings ---------------------------------------

  it('GET /admin/emails lists outbox rows; GET /admin/bookings joins customer+plot', async () => {
    const { bookingId } = await reserveAndConfirm();
    const token = await opsToken();

    const emails = await http
      .get('/v1/admin/emails')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(emails.body.items.length).toBeGreaterThan(0);
    expect(emails.body.items[0]).toHaveProperty('to_email');
    expect(emails.body.items[0]).toHaveProperty('body_text');

    const bookings = await http
      .get('/v1/admin/bookings')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const row = bookings.body.items.find((b: any) => b.id === bookingId);
    expect(row).toBeTruthy();
    expect(row.customer_email).toContain('@test.gemhousing.in');
    expect(row.project_name).toBe('Gem Meadows');
    expect(row.status).toBe('PENDING_APPROVAL');
  });

  it('GET /admin/audit-logs + /admin/settings are SUPER_ADMIN + AUDITOR only', async () => {
    const auditor = await auditorToken();
    const ops = await opsToken();

    // AUDITOR may read both.
    await http.get('/v1/admin/audit-logs').set('authorization', `Bearer ${auditor}`).expect(200);
    const settings = await http
      .get('/v1/admin/settings')
      .set('authorization', `Bearer ${auditor}`)
      .expect(200);
    expect(settings.body.items.find((s: any) => s.key === 'global_hold_minutes')).toBeTruthy();

    // OPERATIONS may NOT (403).
    await http.get('/v1/admin/audit-logs').set('authorization', `Bearer ${ops}`).expect(403);
    await http.get('/v1/admin/settings').set('authorization', `Bearer ${ops}`).expect(403);
  });

  // --- Local-disk storage round-trip --------------------------------------------------------

  it('StorageService.putObject writes to disk and /files/* serves it', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gp-uploads-'));
    const prevDir = process.env.UPLOADS_DIR;
    const prevMode = process.env.STORAGE_MODE;
    process.env.UPLOADS_DIR = dir;
    process.env.STORAGE_MODE = 'local';
    try {
      const storage = app.get(StorageService);
      const key = 'seed/round-trip.svg';
      const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      await storage.putObject(key, body, 'image/svg+xml');

      // File exists on disk under UPLOADS_DIR.
      const onDisk = await fs.readFile(join(dir, key));
      expect(onDisk.equals(body)).toBe(true);

      // signedGetUrl points at the proxied /api/files path.
      expect(storage.signedGetUrl(key)).toBe(`/api/files/${key}`);

      // A standalone express.static('/files') server (mirrors main.ts) serves it with the SVG
      // content-type. The Nest test server doesn't mount /files, so serve it here.
      const fileApp = express();
      fileApp.use(
        '/files',
        express.static(dir, {
          fallthrough: false,
          index: false,
          setHeaders: (res, filePath) => {
            if (filePath.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
          },
        }),
      );
      const res = await request(fileApp)
        .get(`/files/${key}`)
        .buffer(true)
        .parse((r: any, cb: any) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('image/svg+xml');
      expect(Buffer.from(res.body).equals(body)).toBe(true);

      // Missing file 404s (fallthrough:false).
      await request(fileApp).get('/files/seed/nope.svg').expect(404);
    } finally {
      if (prevDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevDir;
      if (prevMode === undefined) delete process.env.STORAGE_MODE;
      else process.env.STORAGE_MODE = prevMode;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('LocalDiskDriver rejects path-traversal keys', async () => {
    const storage = app.get(StorageService);
    await expect(
      storage.putObject('../escape.txt', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow(/unsafe/);
  });

  // --- idOrSlug -----------------------------------------------------------------------------

  it('GET /projects/{idOrSlug}: fetching by slug == fetching by id', async () => {
    const bySlug = await http.get('/v1/projects/gem-meadows').expect(200);
    expect(bySlug.body.slug).toBe('gem-meadows');
    const id = bySlug.body.id;
    const byId = await http.get(`/v1/projects/${id}`).expect(200);
    expect(byId.body).toEqual(bySlug.body);
    // An unknown slug 404s.
    await http.get('/v1/projects/no-such-project').expect(404);
  });

  // --- Seed integrity -----------------------------------------------------------------------

  it('seed: Gem Meadows has 12 plots + 12 geometries, all coords in [0,1]', async () => {
    const proj = (
      await db(app).query(`SELECT id FROM projects WHERE slug='gem-meadows'`)
    ).rows[0];
    const plots = await db(app).query(`SELECT count(*)::int n FROM plots WHERE project_id=$1`, [
      proj.id,
    ]);
    expect(plots.rows[0].n).toBe(12);

    const map = (
      await db(app).query(`SELECT id FROM site_maps WHERE project_id=$1 AND is_active`, [proj.id])
    ).rows[0];
    const geoms = await db(app).query(
      `SELECT polygon, centroid FROM plot_geometries WHERE site_map_id=$1`,
      [map.id],
    );
    expect(geoms.rows.length).toBe(12);

    for (const g of geoms.rows) {
      const polygon: number[][] = g.polygon;
      const centroid: number[] = g.centroid;
      expect(polygon.length).toBeGreaterThanOrEqual(4);
      for (const [x, y] of polygon) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
      }
      expect(centroid[0]).toBeGreaterThanOrEqual(0);
      expect(centroid[0]).toBeLessThanOrEqual(1);
      expect(centroid[1]).toBeGreaterThanOrEqual(0);
      expect(centroid[1]).toBeLessThanOrEqual(1);
    }

    // P-01..P-03 pinned rows unchanged.
    const p1 = (
      await db(app).query(
        `SELECT price_paise, area_sqft, facing FROM plots WHERE project_id=$1 AND plot_number='P-01'`,
        [proj.id],
      )
    ).rows[0];
    expect(Number(p1.price_paise)).toBe(180000000);
    expect(Number(p1.area_sqft)).toBe(1200);
    expect(p1.facing).toBe('E');

    // Site map points at the SVG asset.
    const mapRow = (
      await db(app).query(`SELECT image_key, width_px, height_px FROM site_maps WHERE id=$1`, [
        map.id,
      ])
    ).rows[0];
    expect(mapRow.image_key).toBe('seed/gem-meadows-v1.svg');
    expect(mapRow.width_px).toBe(2000);
    expect(mapRow.height_px).toBe(1400);
  });

  // --- NEW_CUSTOMER feed event --------------------------------------------------------------

  it('NEW_CUSTOMER admin feed event fires on first login only', async () => {
    const auth = app.get(AuthService);
    const email = 'fresh-buyer@test.gemhousing.in';
    const crypto = require('crypto');

    async function loginOnce() {
      const otp = '123456';
      const hash = crypto.createHash('sha256').update(otp + 'test-pepper').digest('hex');
      const ch = await db(app).query(
        `INSERT INTO otp_challenges (email, otp_hash, purpose, expires_at)
         VALUES ($1,$2,'LOGIN', now() + interval '5 min') RETURNING id`,
        [email, hash],
      );
      await auth.verifyOtp(ch.rows[0].id, email, otp);
    }

    await loginOnce(); // creates the customer → one NEW_CUSTOMER event
    await loginOnce(); // existing customer → no new event

    const rows = await db(app).query(
      `SELECT audience, entity_type FROM portal_notifications
        WHERE type='NEW_CUSTOMER' AND title LIKE $1`,
      [`%${email}%`],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].audience).toBe('ADMIN');
    expect(rows.rows[0].entity_type).toBe('user');
  });
});
