import { env } from '../config/env';
import { exec, lockName, pool, q } from '../db/pool';
import { logger } from '../utils/logger';

/**
 * Push notifications through a durable queue (table push_outbox):
 *  1. notifyUsers() stores one row per device token and returns at once (it never throws or blocks a request);
 *  2. flushOutbox() sends due rows to Expo, retrying failures with growing delays (1, 2, 4, 8, 16 minutes);
 *  3. checkReceipts() asks Expo later whether the phone's push service really accepted the message, and forgets dead tokens.
 * Only one server flushes at a time (MySQL advisory lock), so many API instances never double-send.
 */
const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_ATTEMPTS = 6;

export interface Ticket { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } }
export interface Receipt { status: 'ok' | 'error'; message?: string; details?: { error?: string } }
export interface Transport {
  send(messages: { to: string; title: string; body: string; data: unknown; sound: string }[]): Promise<Ticket[]>;
  receipts(ids: string[]): Promise<Record<string, Receipt>>;
}

const expoTransport: Transport = {
  async send(messages) {
    const res = await fetch(EXPO_SEND, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(messages) });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    const json: any = await res.json();
    if (!Array.isArray(json?.data)) throw new Error('Expo push: unexpected response');
    return json.data;
  },
  async receipts(ids) {
    const res = await fetch(EXPO_RECEIPTS, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ids }) });
    if (!res.ok) throw new Error(`Expo receipts HTTP ${res.status}`);
    return ((await res.json()) as any)?.data ?? {};
  },
};

// Tests inject a fake; without one, tests send nothing at all.
let transport: Transport | null = env.isTest ? null : expoTransport;
export const setPushTransport = (t: Transport | null) => { transport = t; };

/** Queue a notification for every device of these users. Fire-and-forget: failures are logged, never thrown. */
export async function notifyUsers(userIds: number[], title: string, body: string, data: Record<string, unknown> = {}) {
  if (!transport || userIds.length === 0) return;
  try {
    const tokens = await q<{ user_id: number; token: string }>(pool, 'SELECT user_id, token FROM push_tokens WHERE user_id IN (?)', [userIds]);
    if (!tokens.length) return;
    await exec(pool, 'INSERT INTO push_outbox (user_id, token, title, body, data, next_attempt_at) VALUES ?', [
      tokens.map((t) => [t.user_id, t.token, title.slice(0, 120), body.slice(0, 300), JSON.stringify(data), new Date()]),
    ]);
    void flushOutbox().catch((err) => logger.error({ err }, 'push flush failed'));
  } catch (err) {
    logger.error({ err }, 'push enqueue failed');
  }
}

const backoffMinutes = (attempts: number) => 2 ** Math.max(0, attempts - 1);

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const c = await pool.getConnection();
  try {
    const [rows] = await c.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [lockName(name)]);
    if (!rows[0].got) return undefined;
    try { return await fn(); } finally { await c.query('SELECT RELEASE_LOCK(?)', [lockName(name)]); }
  } finally { c.release(); }
}

const dropToken = (token: string) => exec(pool, 'DELETE FROM push_tokens WHERE token = ?', [token]);

/** Send everything that is due. Returns how many rows were handled. */
export async function flushOutbox(limit = 200, now = new Date()): Promise<number> {
  if (!transport) return 0;
  const t = transport;
  return (await withLock('aayme_push_flush', async () => {
    const rows = await q<any>(pool, "SELECT * FROM push_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?", [now, limit]);
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      let tickets: Ticket[];
      try {
        tickets = await t.send(batch.map((r) => ({ to: r.token, title: r.title, body: r.body, data: r.data ? JSON.parse(r.data) : {}, sound: 'default' })));
      } catch (err: any) {
        for (const r of batch) await retryLater(r, String(err?.message ?? err), now);   // network / Expo outage: try again later
        continue;
      }
      for (let k = 0; k < batch.length; k++) {
        const r = batch[k]; const tk = tickets[k];
        if (tk?.status === 'ok') {
          await exec(pool, "UPDATE push_outbox SET status = 'sent', ticket_id = ?, attempts = attempts + 1, sent_at = ?, error = NULL WHERE id = ?", [tk.id ?? null, now, r.id]);
        } else if (tk?.details?.error === 'DeviceNotRegistered') {
          await exec(pool, "UPDATE push_outbox SET status = 'dead', attempts = attempts + 1, error = 'DeviceNotRegistered' WHERE id = ?", [r.id]);
          await dropToken(r.token);
        } else if (tk?.details?.error === 'MessageTooBig' || tk?.details?.error === 'InvalidCredentials') {
          await exec(pool, "UPDATE push_outbox SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?", [tk.details.error, r.id]);   // retrying can not help
        } else {
          await retryLater(r, tk?.message ?? tk?.details?.error ?? 'no ticket', now);
        }
      }
    }
    return rows.length;
  })) ?? 0;
}

async function retryLater(r: any, error: string, now: Date) {
  const attempts = r.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) await exec(pool, "UPDATE push_outbox SET status = 'failed', attempts = ?, error = ? WHERE id = ?", [attempts, error.slice(0, 200), r.id]);
  else await exec(pool, 'UPDATE push_outbox SET attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?', [attempts, error.slice(0, 200), new Date(+now + backoffMinutes(attempts) * 60_000), r.id]);
}

/** Ask Expo what became of messages sent at least `minAgeMin` minutes ago. */
export async function checkReceipts(minAgeMin = 15, now = new Date()): Promise<number> {
  if (!transport) return 0;
  const t = transport;
  return (await withLock('aayme_push_receipts', async () => {
    const rows = await q<any>(pool, "SELECT id, token, ticket_id FROM push_outbox WHERE status = 'sent' AND ticket_id IS NOT NULL AND sent_at <= ? AND sent_at > ? ORDER BY id LIMIT 300",
      [new Date(+now - minAgeMin * 60_000), new Date(+now - 24 * 3600_000)]);
    if (!rows.length) return 0;
    let receipts: Record<string, Receipt>;
    try { receipts = await t.receipts(rows.map((r) => r.ticket_id)); } catch (err) { logger.error({ err }, 'push receipts failed'); return 0; }
    for (const r of rows) {
      const rc = receipts[r.ticket_id];
      if (!rc) continue;                                                       // not ready yet; checked again next time
      if (rc.status === 'ok') await exec(pool, "UPDATE push_outbox SET status = 'delivered' WHERE id = ?", [r.id]);
      else if (rc.details?.error === 'DeviceNotRegistered') { await exec(pool, "UPDATE push_outbox SET status = 'dead', error = 'DeviceNotRegistered' WHERE id = ?", [r.id]); await dropToken(r.token); }
      else await exec(pool, "UPDATE push_outbox SET status = 'failed', error = ? WHERE id = ?", [(rc.message ?? rc.details?.error ?? 'rejected').slice(0, 200), r.id]);
    }
    return rows.length;
  })) ?? 0;
}

/** Distributor owner + all active employees. */
export async function teamOf(distributorId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(pool, 'SELECT id FROM users WHERE id = ? OR (owner_distributor_id = ? AND is_active = 1)', [distributorId, distributorId]);
  return rows.map((r) => r.id);
}
