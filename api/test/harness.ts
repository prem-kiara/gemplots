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
  await adminPool.query(`UPDATE plots SET status='AVAILABLE'`);
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
