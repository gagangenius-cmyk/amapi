import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env';

export const pool: Pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'Z',
});

// Every connection works in UTC so CURRENT_TIMESTAMP, UTC_TIMESTAMP() and the JS side always agree,
// whatever timezone the database server runs in.
(pool as any).pool.on('connection', (c: any) => c.query("SET time_zone = '+00:00'"));

/**
 * MySQL advisory locks are shared by every database on the server. Staging and production (or a test run) on one server would
 * otherwise block each other's background jobs, so a lock's name always includes the database it belongs to.
 */
export const lockName = (name: string) => `${name}:${env.db.database}`.slice(0, 64);

export type Conn = Pool | PoolConnection;
export type Row = RowDataPacket;

export async function q<T = Row>(c: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await c.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

export async function q1<T = Row>(c: Conn, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(c, sql, params))[0];
}

export async function exec(c: Conn, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await c.query<ResultSetHeader>(sql, params);
  return res;
}

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Run `fn` in a transaction. When two requests collide, MySQL aborts one with a deadlock error; that is normal under
 * concurrency and the right response is to run the whole transaction again, not to fail the request.
 * `fn` must therefore only touch the database (side effects such as notifications belong after withTx returns).
 */
export async function withTx<T>(fn: (c: PoolConnection) => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const out = await fn(c);
      await c.commit();
      return out;
    } catch (e: any) {
      await c.rollback().catch(() => {});
      if (RETRYABLE.has(e?.code) && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 30));
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
}
