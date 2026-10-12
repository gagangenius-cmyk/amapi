import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise, toPaise } from '../../utils/money';
import { loadTiers } from '../catalog/stock';
import { assertSubscriptionActive } from '../distributors/subscription';
import { KIND_RANK, loadRules, resolvePrice } from './resolver';

/** The distributor's price lists: who gets which price, for what, and when. Owner only. */
export const pricingRouter = Router();
pricingRouter.use(authenticate, requireRole('distributor'));

const KINDS = ['contract', 'promotion', 'group', 'regional'] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-10-31').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Not a real date');
const prefix = z.string().regex(/^\d{1,6}$/, 'A pincode or the start of one (up to 6 digits)');

const listBody = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(KINDS),
  priority: z.number().int().min(-1000).max(1000).default(0),
  valid_from: day.nullable().optional(), valid_to: day.nullable().optional(),
  pincode_prefixes: z.array(prefix).max(100).optional(),
  allow_above_standard: z.boolean().default(false),
  is_active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'The end date is before the start date' });
  if (v.kind === 'regional' && !v.pincode_prefixes?.length) ctx.addIssue({ code: 'custom', path: ['pincode_prefixes'], message: 'A regional list needs at least one pincode prefix' });
});

const present = (l: any, extra: object = {}) => ({
  id: l.id, name: l.name, kind: l.kind, priority: l.priority, valid_from: l.valid_from ? String(l.valid_from).slice(0, 10) : null, valid_to: l.valid_to ? String(l.valid_to).slice(0, 10) : null,
  pincode_prefixes: l.pincode_prefixes ? JSON.parse(l.pincode_prefixes) : [], allow_above_standard: !!l.allow_above_standard, is_active: !!l.is_active,
  members: Number(l.members ?? 0), items: Number(l.items ?? 0), ...extra,
});
const LIST_SQL = `SELECT pl.*, (SELECT COUNT(*) FROM price_list_members m WHERE m.price_list_id = pl.id) members,
  (SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = pl.id) items FROM price_lists pl`;

const owned = async (c: any, id: number, d: number) => {
  const l = await q1<any>(c, `${LIST_SQL} WHERE pl.id = ? AND pl.distributor_id = ?`, [id, d]);
  if (!l) throw notFound('Price list');
  return l;
};

pricingRouter.get('/lists', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `${LIST_SQL} WHERE pl.distributor_id = ? ORDER BY pl.is_active DESC, pl.kind, pl.priority DESC, pl.name`, [req.auth!.userId]);
  res.json({ lists: rows.map((r) => present(r)), precedence: KINDS.map((k) => ({ kind: k, rank: KIND_RANK[k] })) });
}));

pricingRouter.post('/lists', asyncHandler(async (req, res) => {
  const b = listBody.parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  try {
    const r = await exec(pool, `INSERT INTO price_lists (distributor_id, name, kind, priority, valid_from, valid_to, pincode_prefixes, allow_above_standard, is_active, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [d, b.name, b.kind, b.priority, b.valid_from ?? null, b.valid_to ?? null, b.kind === 'regional' ? JSON.stringify([...new Set(b.pincode_prefixes)]) : null, b.allow_above_standard ? 1 : 0, b.is_active ? 1 : 0, d]);
    await audit(d, 'pricing.list_create', 'price_list', r.insertId, { name: b.name, kind: b.kind });
    res.status(201).json(present(await owned(pool, r.insertId, d)));
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', 'You already have a price list with this name');
    throw e;
  }
}));

pricingRouter.get('/lists/:id', asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req);
  const l = await owned(pool, id, d);
  const members = await q<any>(pool, `SELECT u.id, rp.shop_name, u.phone FROM price_list_members m JOIN users u ON u.id = m.retailer_id JOIN retailer_profiles rp ON rp.user_id = u.id
    WHERE m.price_list_id = ? ORDER BY rp.shop_name`, [id]);
  const items = await q<any>(pool, `SELECT i.id, i.product_id, p.name, p.unit, p.price_paise, i.mode, i.value, i.min_qty FROM price_list_items i JOIN products p ON p.id = i.product_id
    WHERE i.price_list_id = ? ORDER BY p.name, i.min_qty`, [id]);
  res.json(present(l, {
    member_list: members,
    item_list: items.map((i) => ({
      id: i.id, product_id: i.product_id, name: i.name, unit: i.unit, standard_price: fromPaise(Number(i.price_paise)), mode: i.mode, min_qty: i.min_qty,
      price: i.mode === 'fixed' ? fromPaise(Number(i.value)) : null, percent_off: i.mode === 'percent_off' ? Number(i.value) / 100 : null,
    })),
  }));
}));

pricingRouter.put('/lists/:id', asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req);
  const cur = await owned(pool, id, d);
  const merged = {
    name: cur.name, kind: cur.kind, priority: cur.priority, valid_from: cur.valid_from ? String(cur.valid_from).slice(0, 10) : null, valid_to: cur.valid_to ? String(cur.valid_to).slice(0, 10) : null,
    pincode_prefixes: cur.pincode_prefixes ? JSON.parse(cur.pincode_prefixes) : [], allow_above_standard: !!cur.allow_above_standard, is_active: !!cur.is_active,
    ...(z.object({}).passthrough().parse(req.body ?? {})),
  };
  const b = listBody.parse(merged);
  try {
    await exec(pool, `UPDATE price_lists SET name = ?, kind = ?, priority = ?, valid_from = ?, valid_to = ?, pincode_prefixes = ?, allow_above_standard = ?, is_active = ? WHERE id = ?`,
      [b.name, b.kind, b.priority, b.valid_from ?? null, b.valid_to ?? null, b.kind === 'regional' ? JSON.stringify([...new Set(b.pincode_prefixes)]) : null, b.allow_above_standard ? 1 : 0, b.is_active ? 1 : 0, id]);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', 'You already have a price list with this name');
    throw e;
  }
  await audit(d, 'pricing.list_update', 'price_list', id, { before: { kind: cur.kind, priority: cur.priority, is_active: !!cur.is_active, valid_from: cur.valid_from, valid_to: cur.valid_to }, after: b });
  res.json(present(await owned(pool, id, d)));
}));

// A list that priced an order is kept (switch it off instead); an unused one can go.
pricingRouter.delete('/lists/:id', asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req);
  await owned(pool, id, d);
  const used = await q1<any>(pool, 'SELECT COUNT(*) n FROM order_items WHERE price_list_id = ?', [id]);
  if (Number(used!.n) > 0) throw new AppError(409, 'IN_USE', 'Orders were priced with this list, so it is kept for the record. Switch it off instead.');
  await exec(pool, 'DELETE FROM price_lists WHERE id = ?', [id]);
  await audit(d, 'pricing.list_delete', 'price_list', id);
  res.status(204).end();
}));

// Who the list applies to: replaces the whole set. Only retailers this distributor actually supplies.
pricingRouter.put('/lists/:id/members', asyncHandler(async (req, res) => {
  const { retailer_ids } = z.object({ retailer_ids: z.array(z.number().int().positive()).max(2000) }).parse(req.body);
  const d = req.auth!.userId; const id = idParam(req);
  const l = await owned(pool, id, d);
  if (l.kind === 'regional') throw new AppError(400, 'REGIONAL_LIST', 'A regional list applies by pincode, not by member');
  const ids = [...new Set(retailer_ids)];
  if (ids.length) {
    const ok = await q<any>(pool, "SELECT retailer_id FROM retailer_distributor_relations WHERE distributor_id = ? AND status = 'active' AND retailer_id IN (?)", [d, ids]);
    const bad = ids.filter((x) => !ok.some((o) => o.retailer_id === x));
    if (bad.length) throw new AppError(400, 'NOT_YOUR_RETAILER', `Not one of your retailers: ${bad.join(', ')}`);
  }
  await withTx(async (c) => {
    await exec(c, 'DELETE FROM price_list_members WHERE price_list_id = ?', [id]);
    if (ids.length) await exec(c, 'INSERT INTO price_list_members (price_list_id, retailer_id) VALUES ?', [ids.map((r) => [id, r])]);
  });
  await audit(d, 'pricing.list_members', 'price_list', id, { count: ids.length });
  res.json({ members: ids.length });
}));

const itemBody = z.object({
  product_id: z.number().int().positive(),
  min_qty: z.number().int().min(1).max(1_000_000).default(1),
}).and(z.union([
  z.object({ price: z.union([z.string(), z.number()]) }),
  z.object({ percent_off: z.number().min(0).max(95) }),
]));

pricingRouter.post('/lists/:id/items', asyncHandler(async (req, res) => {
  const b = itemBody.parse(req.body);
  const d = req.auth!.userId; const id = idParam(req);
  await owned(pool, id, d);
  if (!(await q1(pool, 'SELECT 1 FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [b.product_id, d]))) throw notFound('Product');
  const fixed = 'price' in b;
  const value = fixed ? toPaise(b.price) : Math.round(b.percent_off * 100);
  await exec(pool, `INSERT INTO price_list_items (price_list_id, product_id, mode, value, min_qty) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE mode = VALUES(mode), value = VALUES(value)`, [id, b.product_id, fixed ? 'fixed' : 'percent_off', value, b.min_qty]);
  await audit(d, 'pricing.item_set', 'price_list', id, { product_id: b.product_id, min_qty: b.min_qty, mode: fixed ? 'fixed' : 'percent_off', value });
  res.status(201).json({ ok: true });
}));

pricingRouter.delete('/lists/:id/items/:itemId', asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req); const itemId = idParam(req, 'itemId');
  await owned(pool, id, d);
  const r = await exec(pool, 'DELETE FROM price_list_items WHERE id = ? AND price_list_id = ?', [itemId, id]);
  if (!r.affectedRows) throw notFound('Item');
  await audit(d, 'pricing.item_remove', 'price_list', id, { item_id: itemId });
  res.status(204).end();
}));

// Changes made to a list, newest first (from the audit trail).
pricingRouter.get('/lists/:id/history', asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req);
  await owned(pool, id, d);
  const rows = await q<any>(pool, "SELECT id, action, meta, created_at FROM audit_log WHERE entity = 'price_list' AND entity_id = ? AND actor_id = ? ORDER BY id DESC LIMIT 100", [id, d]);
  res.json({ entries: rows.map((r) => ({ id: r.id, action: r.action, at: r.created_at, details: r.meta ? JSON.parse(r.meta) : null })) });
}));

// "What would this retailer pay?" with the reasoning, so a disputed price can be explained.
pricingRouter.get('/quote', asyncHandler(async (req, res) => {
  const qs = z.object({
    retailer_id: z.coerce.number().int().positive(), product_id: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().min(1).max(1_000_000).default(1), date: day.optional(),
  }).parse(req.query);
  const d = req.auth!.userId;
  const p = await q1<any>(pool, 'SELECT id, name, price_paise FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [qs.product_id, d]);
  if (!p) throw notFound('Product');
  const r = await q1<any>(pool, `SELECT rp.pincode, rp.shop_name FROM retailer_distributor_relations x JOIN retailer_profiles rp ON rp.user_id = x.retailer_id
    WHERE x.distributor_id = ? AND x.retailer_id = ? AND x.status = 'active'`, [d, qs.retailer_id]);
  if (!r) throw notFound('Retailer');
  const tiers = (await loadTiers(pool, [p.id])).get(p.id) ?? [];
  const rules = (await loadRules(pool, { distributorId: d, retailerId: qs.retailer_id, pincode: r.pincode, productIds: [p.id], onDate: qs.date })).get(p.id) ?? [];
  const out = resolvePrice(Number(p.price_paise), tiers, rules, qs.qty);
  res.json({
    product: p.name, retailer: r.shop_name, qty: qs.qty, date: qs.date ?? new Date().toISOString().slice(0, 10),
    unit_price: fromPaise(out.unit_paise), standard_price: fromPaise(out.standard_paise), basis: out.basis,
    applied: out.list_id ? { list_id: out.list_id, name: out.list_name, kind: out.kind } : null,
    considered: out.considered.map((c, i) => ({ ...c, unit_price: fromPaise(c.unit_paise), unit_paise: undefined, winner: i === 0 && out.list_id === c.list_id })),
  });
}));
