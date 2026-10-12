import { AuthCtx } from '../../middleware/auth';
import { exec, pool, q, q1 } from '../../db/pool';
import { AppError, forbidden } from '../../utils/errors';
import { notifyUsers, teamOf } from '../../services/notify';
import { assertPermission } from '../distributors/subscription';

export interface Message {
  id: number; distributor_id: number; retailer_id: number; sender_id: number; body: string; client_id: string | null; created_at: string;
}

type Broadcast = (m: Message) => void;
let broadcast: Broadcast = () => {};
export const setBroadcaster = (fn: Broadcast) => { broadcast = fn; };

export interface ReadEvent { distributor_id: number; retailer_id: number; reader_id: number; last_read_id: number }
let broadcastRead: (e: ReadEvent) => void = () => {};
export const setReadBroadcaster = (fn: (e: ReadEvent) => void) => { broadcastRead = fn; };

/** Resolve which (distributor, retailer) conversation the caller is addressing and verify they belong to it. */
export async function resolvePair(a: AuthCtx, distributorId?: number, retailerId?: number) {
  let d: number, r: number;
  if (a.role === 'retailer') {
    if (!distributorId) throw new AppError(400, 'VALIDATION', 'distributor_id required');
    d = distributorId; r = a.userId;
  } else if (a.role === 'distributor' || a.role === 'employee') {
    if (!retailerId) throw new AppError(400, 'VALIDATION', 'retailer_id required');
    d = a.distributorId!; r = retailerId;
  } else throw forbidden();
  if (!(await q1(pool, 'SELECT 1 FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = "active"', [r, d]))) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
  await assertPermission(pool, d, 'chat_enabled');
  return { d, r };
}

export async function sendMessage(a: AuthCtx, pair: { d: number; r: number }, body: string, clientId?: string): Promise<{ message: Message; replayed: boolean }> {
  const text = body.trim();
  if (!text || text.length > 2000) throw new AppError(400, 'VALIDATION', 'Message must be 1-2000 characters');
  if (clientId) {
    const dup = await q1<Message>(pool, 'SELECT * FROM chat_messages WHERE sender_id = ? AND client_id = ?', [a.userId, clientId]);
    if (dup) return { message: dup, replayed: true };
  }
  let id: number;
  try {
    id = (await exec(pool, 'INSERT INTO chat_messages (distributor_id, retailer_id, sender_id, body, client_id) VALUES (?,?,?,?,?)', [pair.d, pair.r, a.userId, text, clientId ?? null])).insertId;
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY' && clientId) return { message: (await q1<Message>(pool, 'SELECT * FROM chat_messages WHERE sender_id = ? AND client_id = ?', [a.userId, clientId]))!, replayed: true };
    throw e;
  }
  const message = (await q1<Message>(pool, 'SELECT * FROM chat_messages WHERE id = ?', [id]))!;
  await markRead(a.userId, pair, id, false);
  broadcast(message);
  const recipients = a.role === 'retailer' ? await teamOf(pair.d) : [pair.r];
  notifyUsers(recipients.filter((u) => u !== a.userId), 'New message', text.slice(0, 100), { type: 'chat', distributor_id: pair.d, retailer_id: pair.r });
  return { message, replayed: false };
}

/** Record that `userId` has seen messages up to `upTo`. Tells the other side (live) so they can show "seen". */
export async function markRead(userId: number, pair: { d: number; r: number }, upTo: number, announce = true) {
  const r = await exec(pool, 'INSERT INTO chat_reads (user_id, distributor_id, retailer_id, last_read_id) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))', [userId, pair.d, pair.r, upTo]);
  if (announce && r.affectedRows) broadcastRead({ distributor_id: pair.d, retailer_id: pair.r, reader_id: userId, last_read_id: upTo });
}

/** How far the OTHER side has read: for a retailer, the furthest any distributor-team member read; for the team, the retailer. */
export async function peerLastRead(a: AuthCtx, pair: { d: number; r: number }): Promise<number> {
  const row = await q1<any>(pool, `SELECT COALESCE(MAX(last_read_id), 0) n FROM chat_reads WHERE distributor_id = ? AND retailer_id = ? AND ${a.role === 'retailer' ? 'user_id <> ?' : 'user_id = ?'}`,
    [pair.d, pair.r, a.role === 'retailer' ? a.userId : pair.r]);
  return Number(row.n);
}

export async function history(pair: { d: number; r: number }, before?: number, limit = 50) {
  const rows = await q<Message>(pool, `SELECT * FROM chat_messages WHERE distributor_id = ? AND retailer_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    before ? [pair.d, pair.r, before, limit] : [pair.d, pair.r, limit]);
  return rows.reverse();
}

export async function conversations(a: AuthCtx, limit = 50, offset = 0) {
  const where = a.role === 'retailer' ? 'rdr.retailer_id = ?' : 'rdr.distributor_id = ?';
  const arg = a.role === 'retailer' ? a.userId : a.distributorId;
  return q<any>(pool, `
    SELECT rdr.distributor_id, rdr.retailer_id, dp.business_name, rp.shop_name,
      (SELECT body FROM chat_messages m WHERE m.distributor_id = rdr.distributor_id AND m.retailer_id = rdr.retailer_id ORDER BY m.id DESC LIMIT 1) last_body,
      (SELECT created_at FROM chat_messages m WHERE m.distributor_id = rdr.distributor_id AND m.retailer_id = rdr.retailer_id ORDER BY m.id DESC LIMIT 1) last_at,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.distributor_id = rdr.distributor_id AND m.retailer_id = rdr.retailer_id AND m.sender_id <> ?
         AND m.id > COALESCE((SELECT last_read_id FROM chat_reads cr WHERE cr.user_id = ? AND cr.distributor_id = rdr.distributor_id AND cr.retailer_id = rdr.retailer_id), 0)) unread
    FROM retailer_distributor_relations rdr
    JOIN distributor_profiles dp ON dp.user_id = rdr.distributor_id
    JOIN retailer_profiles rp ON rp.user_id = rdr.retailer_id
    WHERE ${where} AND rdr.status = 'active' ORDER BY last_at IS NULL, last_at DESC LIMIT ? OFFSET ?`, [a.userId, a.userId, arg, limit, offset]);
}
