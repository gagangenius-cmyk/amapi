import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1 } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { assertPermission, assertSubscriptionActive, DEFAULT_PERMISSIONS } from '../distributors/subscription';

/**
 * Offers and news from a distributor to its retailers. Sent as a push notification AND kept in an in-app "Offers" list,
 * so a retailer who missed the push (or has them switched off) still sees it.
 *   audience "all"      - every retailer connected to the distributor
 *   audience "pincodes" - retailers in the chosen pincodes: connected ones, plus unconnected ones in a pincode the
 *                         distributor sells to (only while "sell by pincode" is on)
 */
export const announcementRouter = Router();
announcementRouter.use(authenticate);

const MAX_PER_DAY = 10;
const PUSH_CHUNK = 1000;

const body = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(3).max(500),
  audience: z.enum(['all', 'pincodes']).default('all'),
  pincodes: z.array(z.string().regex(/^\d{6}$/)).max(50).optional(),
  product_id: z.number().int().positive().optional(),
  valid_until: z.string().date().optional(),
}).refine((b) => b.audience === 'all' || (b.pincodes?.length ?? 0) > 0, { message: 'Choose at least one pincode', path: ['pincodes'] });

/** Who would receive an announcement right now. */
export async function recipientsOf(distributorId: number, audience: 'all' | 'pincodes', pincodes: string[] = []): Promise<number[]> {
  const d = await q1<any>(pool, 'SELECT permissions FROM distributor_profiles WHERE user_id = ?', [distributorId]);
  const perms = { ...DEFAULT_PERMISSIONS, ...JSON.parse(d!.permissions) };
  const linked = await q<any>(pool, `SELECT rdr.retailer_id id, rp.pincode FROM retailer_distributor_relations rdr JOIN retailer_profiles rp ON rp.user_id = rdr.retailer_id
    JOIN users u ON u.id = rdr.retailer_id WHERE rdr.distributor_id = ? AND rdr.status = 'active' AND u.is_active = 1`, [distributorId]);
  if (audience === 'all') return linked.map((r) => r.id);
  const ids = new Set<number>(linked.filter((r) => pincodes.includes(r.pincode)).map((r) => r.id));
  if (perms.pincode_selling) {
    const sells = await q<any>(pool, 'SELECT pincode FROM service_pincodes WHERE distributor_id = ?', [distributorId]);
    const mine = pincodes.filter((p) => sells.some((s) => s.pincode === p));
    if (mine.length) for (const r of await q<any>(pool, 'SELECT rp.user_id id FROM retailer_profiles rp JOIN users u ON u.id = rp.user_id WHERE rp.pincode IN (?) AND u.is_active = 1', [mine])) ids.add(r.id);
  }
  return [...ids];
}

announcementRouter.post('/', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = body.parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  await assertPermission(pool, d, 'notifications_enabled');
  const today = (await q1<any>(pool, "SELECT COUNT(*) n FROM announcements WHERE distributor_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)", [d]))!.n;
  if (Number(today) >= MAX_PER_DAY) throw new AppError(429, 'TOO_MANY_OFFERS', `You can send ${MAX_PER_DAY} offers a day. Try again tomorrow.`);
  if (b.product_id && !(await q1(pool, 'SELECT 1 FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [b.product_id, d]))) throw new AppError(400, 'BAD_PRODUCT', 'That product is not in your catalog');

  const ids = await recipientsOf(d, b.audience, b.pincodes);
  const r = await exec(pool, 'INSERT INTO announcements (distributor_id, title, body, audience, pincodes, product_id, valid_until, recipients, created_by) VALUES (?,?,?,?,?,?,?,?,?)', [
    d, b.title, b.body, b.audience, b.audience === 'pincodes' ? JSON.stringify(b.pincodes) : null, b.product_id ?? null, b.valid_until ?? null, ids.length, d,
  ]);
  const name = (await q1<any>(pool, 'SELECT business_name FROM distributor_profiles WHERE user_id = ?', [d]))!.business_name;
  for (let i = 0; i < ids.length; i += PUSH_CHUNK) void notifyUsers(ids.slice(i, i + PUSH_CHUNK), `${name}: ${b.title}`, b.body, { type: 'offer', id: r.insertId, distributor_id: d });
  await audit(d, 'announcement.send', 'announcement', r.insertId, { recipients: ids.length, audience: b.audience });
  res.status(201).json({ id: r.insertId, recipients: ids.length });
}));

// How many would get it, before sending.
announcementRouter.get('/audience', requireRole('distributor'), asyncHandler(async (req, res) => {
  const qs = z.object({ audience: z.enum(['all', 'pincodes']).default('all'), pincodes: z.string().optional() }).parse(req.query);
  const pins = (qs.pincodes ?? '').split(',').map((p) => p.trim()).filter((p) => /^\d{6}$/.test(p));
  res.json({ recipients: (await recipientsOf(req.auth!.userId, qs.audience, pins)).length });
}));

announcementRouter.get('/', requireRole('distributor', 'retailer'), asyncHandler(async (req, res) => {
  const a = req.auth!;
  if (a.role === 'distributor') {
    const rows = await q<any>(pool, `SELECT a.*, p.name product_name FROM announcements a LEFT JOIN products p ON p.id = a.product_id WHERE a.distributor_id = ? ORDER BY a.id DESC LIMIT 50`, [a.userId]);
    return void res.json({ announcements: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, audience: r.audience, pincodes: r.pincodes ? JSON.parse(r.pincodes) : [], product_name: r.product_name, valid_until: r.valid_until, recipients: r.recipients, created_at: r.created_at })) });
  }
  const me = (await q1<any>(pool, 'SELECT pincode, offers_seen_at FROM retailer_profiles WHERE user_id = ?', [a.userId]))!;
  const rows = await q<any>(pool, `
    SELECT a.*, dp.business_name, dp.permissions, p.name product_name, p.variant_label,
      EXISTS (SELECT 1 FROM retailer_distributor_relations r WHERE r.retailer_id = ? AND r.distributor_id = a.distributor_id AND r.status = 'active') AS is_linked,
      EXISTS (SELECT 1 FROM service_pincodes sp WHERE sp.distributor_id = a.distributor_id AND sp.pincode = ?) AS sells_here
    FROM announcements a JOIN distributor_profiles dp ON dp.user_id = a.distributor_id LEFT JOIN products p ON p.id = a.product_id
    WHERE a.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY) AND (a.valid_until IS NULL OR a.valid_until >= UTC_DATE()) AND dp.subscription_ends_at > UTC_TIMESTAMP()
    ORDER BY a.id DESC LIMIT 200`, [a.userId, me.pincode]);
  const seen = me.offers_seen_at ? +new Date(me.offers_seen_at) : 0;
  const mine = rows.filter((r) => {
    if (r.is_linked) return r.audience === 'all' || (JSON.parse(r.pincodes ?? '[]') as string[]).includes(me.pincode);
    // not connected: only pincode offers for a pincode the distributor sells to, and only while pincode selling is on
    return r.audience === 'pincodes' && r.sells_here && ({ ...DEFAULT_PERMISSIONS, ...JSON.parse(r.permissions) }).pincode_selling && (JSON.parse(r.pincodes ?? '[]') as string[]).includes(me.pincode);
  }).slice(0, 50);
  res.json({
    unread: mine.filter((r) => +new Date(r.created_at) > seen).length,
    offers: mine.map((r) => ({ id: r.id, distributor_id: r.distributor_id, distributor_name: r.business_name, title: r.title, body: r.body, product_name: r.product_name ? (r.variant_label ? `${r.product_name} · ${r.variant_label}` : r.product_name) : null, product_id: r.product_id, valid_until: r.valid_until, created_at: r.created_at, unread: +new Date(r.created_at) > seen, connected: !!r.is_linked })),
  });
}));

announcementRouter.post('/seen', requireRole('retailer'), asyncHandler(async (req, res) => {
  await exec(pool, 'UPDATE retailer_profiles SET offers_seen_at = UTC_TIMESTAMP() WHERE user_id = ?', [req.auth!.userId]);
  res.status(204).end();
}));

announcementRouter.delete('/:id', requireRole('distributor'), asyncHandler(async (req, res) => {
  const r = await exec(pool, 'DELETE FROM announcements WHERE id = ? AND distributor_id = ?', [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Offer');
  res.status(204).end();
}));
