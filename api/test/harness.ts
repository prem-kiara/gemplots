import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { ErrorFilter } from '../src/common/http/error.filter';
import { DbService } from '../src/common/db/db.service';
import { RedisService } from '../src/common/redis/redis.service';

/**
 * Owner connection for test cleanup only. The app runs as gemplots_app (non-owner) which — by
 * design (Invariant 10) — cannot TRUNCATE or DELETE audit_logs. Tests reset via the owner.
 */
const adminPool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_ADMIN ?? 'postgres://localhost:5432/gemplots_test',
});

/**
 * Integration harness. Boots the real Nest app against the real test Postgres (the invariants
 * live in the DB, so no DB mocks — per the test plan). Redis is disabled so tests don't depend
 * on a running Redis; correctness comes from Postgres + sweeper/lazy-repair.
 */
export async function makeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.get(RedisService).disable();
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

export function db(app: INestApplication): DbService {
  return app.get(DbService);
}

/** Reset dynamic state between tests; keeps seed reference data (projects/plots/users/settings). */
/**
 * Pristine snapshot of the seed plots' mutable fields, captured once at the first reset (before
 * any test mutates them). Restoring from it every reset gives full cross-test isolation — earlier
 * resets only reset `status`, so a controlled-action test that changed a plot's price/attributes
 * (P7 maker-checker) leaked that state to other spec files, causing a rare order-dependent flake.
 */
let plotBaseline: Array<{
  id: string;
  status: string;
  price_paise: string;
  facing: string | null;
  dimensions_text: string;
  area_sqft: string;
  attributes: any;
}> | null = null;

export async function resetDynamic(_app: INestApplication) {
  await adminPool.query(`TRUNCATE
    webhook_events, payments, bookings, reconciliation_items, reconciliation_runs,
    approvals, notifications, emails_outbox, portal_notifications,
    otp_challenges, refresh_tokens, device_tokens, audit_logs
    RESTART IDENTITY CASCADE`);
  // Drop any non-seed projects created by tests (and their children).
  await adminPool.query(`DELETE FROM plot_geometries WHERE plot_id IN
      (SELECT p.id FROM plots p JOIN projects pr ON pr.id=p.project_id
        WHERE pr.slug <> 'gem-meadows')`);
  await adminPool.query(`DELETE FROM site_maps WHERE project_id IN
      (SELECT id FROM projects WHERE slug <> 'gem-meadows')`);
  await adminPool.query(`DELETE FROM plots WHERE project_id IN
      (SELECT id FROM projects WHERE slug <> 'gem-meadows')`);
  await adminPool.query(`DELETE FROM projects WHERE slug <> 'gem-meadows'`);

  // Restore the seed plots to their full baseline (status + price + attributes), not just status.
  if (!plotBaseline) {
    // The DB may already be drifted from a prior run; pin the three anchor plots that tests
    // assert exact prices on, then snapshot the deterministic baseline once.
    await adminPool.query(
      `UPDATE plots SET price_paise = CASE plot_number
         WHEN 'P-01' THEN 180000000 WHEN 'P-02' THEN 225000000 WHEN 'P-03' THEN 360000000
         ELSE price_paise END, status='AVAILABLE'
       WHERE project_id=(SELECT id FROM projects WHERE slug='gem-meadows')`,
    );
    plotBaseline = (
      await adminPool.query(
        `SELECT p.id, p.status, p.price_paise, p.facing, p.dimensions_text, p.area_sqft, p.attributes
           FROM plots p JOIN projects pr ON pr.id=p.project_id WHERE pr.slug='gem-meadows'`,
      )
    ).rows;
  }
  for (const b of plotBaseline) {
    await adminPool.query(
      `UPDATE plots SET status=$2, price_paise=$3, facing=$4, dimensions_text=$5,
              area_sqft=$6, attributes=$7 WHERE id=$1`,
      [b.id, 'AVAILABLE', b.price_paise, b.facing, b.dimensions_text, b.area_sqft, b.attributes],
    );
  }
  // Customers are keyed by email now (08 §4). Test customers use @test.gemhousing.in; also sweep
  // any legacy placeholder rows left from the V5 phone→email backfill. Keep the seed customer.
  await adminPool.query(
    `DELETE FROM users WHERE role='CUSTOMER'
       AND (email LIKE '%@test.gemhousing.in'
            OR email LIKE '%@placeholder.gemhousing.in'
            OR phone LIKE '+919%')`,
  );
}

export async function closeAdminPool() {
  await adminPool.end();
}

export async function firstPlotId(app: INestApplication): Promise<string> {
  return (await db(app).query(`SELECT id FROM plots ORDER BY plot_number LIMIT 1`)).rows[0].id;
}

/**
 * SQL fixture for a DORMANT BLOCKED booking (08 §10). The reserve flow no longer produces BLOCKED
 * bookings, but the payment/webhook suite still exercises the dormant order + webhook machinery
 * against them. Inserts a BLOCKED booking (1440-min hold, +1d expiry, price from the plot) and
 * marks the plot BLOCKED. Returns the booking id. Uses the owner conn so it also works when the
 * app role's constraints tighten. The two-PENDING-status sweeper filters guarantee these are
 * never swept.
 */
export async function makeDormantBlockedBooking(
  _app: INestApplication,
  userId: string,
  plotId: string,
): Promise<string> {
  const price = (await adminPool.query(`SELECT price_paise FROM plots WHERE id=$1`, [plotId]))
    .rows[0].price_paise;
  const b = await adminPool.query(
    `INSERT INTO bookings
       (plot_id, user_id, status, total_price_paise, hold_minutes, expires_at, idempotency_key)
     VALUES ($1,$2,'BLOCKED',$3,1440, now() + interval '1 day', $4)
     RETURNING id`,
    [plotId, userId, price, randomKey()],
  );
  await adminPool.query(`UPDATE plots SET status='BLOCKED' WHERE id=$1`, [plotId]);
  return b.rows[0].id;
}

function randomKey(): string {
  return 'fixture-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Create N fresh customer users (keyed by unique email now — 08 §4), return their ids. */
export async function makeCustomers(app: INestApplication, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const email = `cust${i}@test.gemhousing.in`; // unique per i, swept by resetDynamic
    const r = await db(app).query(
      `INSERT INTO users (email, role) VALUES ($1,'CUSTOMER') RETURNING id`,
      [email],
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}
