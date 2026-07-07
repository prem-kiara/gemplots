import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Executor {
  query<R extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<QueryResult<R>>;
}

/**
 * Thin pg wrapper. The critical flows (CF doc) are written as raw SQL and run through here.
 * Services accept an optional Executor so a caller can thread its transaction in (01-arch §3).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ??
        'postgres://dhanam_app:dhanam_app_dev@localhost:5432/dhanam',
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }

  query<R extends QueryResultRow = any>(text: string, params: any[] = []) {
    return this.pool.query<R>(text, params);
  }

  /** Run fn inside a single transaction; commit on success, rollback on throw. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

/** True when err is a unique-violation on the named constraint/index. */
export function isUniqueViolation(err: any, constraint?: string): boolean {
  if (err?.code !== '23505') return false;
  return constraint ? err?.constraint === constraint : true;
}
