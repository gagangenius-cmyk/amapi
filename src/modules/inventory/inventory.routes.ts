import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { assertSubscriptionActive } from '../distributors/subscription';
import { defaultWarehouse } from '../catalog/stock';
import { listWarehouses, markDamaged, positions, reconcile, recoverDamaged, summary, transferStock, warehouseKey, writeOffDamaged } from './inventory.service';

/** The distributor's inventory book: where stock is, what is promised, what is damaged, and what it is worth. Owner only. */
export const inventoryRouter = Router();
inventoryRouter.use(authenticate, requireRole('distributor'));

inventoryRouter.get('/summary', asyncHandler(async (req, res) => {
  res.json(await summary(req.auth!.userId));
}));

inventoryRouter.get('/positions', asyncHandler(async (req, res) => {
  const qs = z.object({
    q: z.string().trim().max(80).optional(), warehouse_id: z.coerce.number().int().positive().optional(),
    low: z.enum(['0', '1']).default('0'), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  res.json({ positions: await positions(req.auth!.userId, { q: qs.q, warehouseId: qs.warehouse_id, lowOnly: qs.low === '1', limit: qs.limit, offset: qs.offset }) });
}));

// ---- warehouses ----
inventoryRouter.get('/warehouses', asyncHandler(async (req, res) => {
  await defaultWarehouse(pool, req.auth!.userId);   // a distributor with no stock yet still sees their first warehouse
  res.json({ warehouses: await listWarehouses(req.auth!.userId) });
}));

inventoryRouter.post('/warehouses', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(80), address: z.string().trim().max(255).nullable().optional() }).parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  try {
    const r = await exec(pool, 'INSERT INTO warehouses (distributor_id, name, name_key, address) VALUES (?,?,?,?)', [d, b.name.replace(/\s+/g, ' '), warehouseKey(b.name), b.address ?? null]);
    await audit(d, 'inventory.warehouse_create', 'warehouse', r.insertId, { name: b.name });
    res.status(201).json({ id: r.insertId, name: b.name });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', 'You already have a warehouse with this name');
    throw e;
  }
}));

inventoryRouter.put('/warehouses/:id', asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(80).optional(), address: z.string().trim().max(255).nullable().optional(),
    is_active: z.boolean().optional(), is_default: z.literal(true).optional(),
  }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const d = req.auth!.userId; const id = idParam(req);
  await withTx(async (c) => {
    const w = await q1<any>(c, 'SELECT * FROM warehouses WHERE id = ? AND distributor_id = ? FOR UPDATE', [id, d]);
    if (!w) throw notFound('Warehouse');
    if (b.is_active === false) {
      if (w.is_default) throw new AppError(409, 'IS_DEFAULT', 'Make another warehouse the default first');
      const held = await q1<any>(c, 'SELECT COALESCE(SUM(qty),0) u, COALESCE(SUM(damaged_qty),0) x FROM inventory_balances WHERE warehouse_id = ?', [id]);
      if (Number(held!.u) > 0 || Number(held!.x) > 0) throw new AppError(409, 'NOT_EMPTY', 'This warehouse still holds stock. Transfer it out first.');
    }
    if (b.is_default) {
      if (!w.is_active) throw new AppError(409, 'INACTIVE', 'Reactivate the warehouse first');
      await exec(c, 'UPDATE warehouses SET is_default = 0 WHERE distributor_id = ?', [d]);
    }
    try {
      await exec(c, 'UPDATE warehouses SET name = ?, name_key = ?, address = ?, is_active = ?, is_default = ? WHERE id = ?', [
        b.name ?? w.name, warehouseKey(b.name ?? w.name), b.address === undefined ? w.address : b.address,
        b.is_active === undefined ? w.is_active : b.is_active ? 1 : 0, b.is_default ? 1 : w.is_default, id,
      ]);
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', 'You already have a warehouse with this name');
      throw e;
    }
  });
  await audit(d, 'inventory.warehouse_update', 'warehouse', id, b);
  res.json({ warehouses: await listWarehouses(d) });
}));

// ---- moves ----
const move = z.object({ product_id: z.number().int().positive(), qty: z.number().int().min(1).max(10_000_000), note: z.string().trim().max(200).optional() });

inventoryRouter.post('/transfers', asyncHandler(async (req, res) => {
  const b = move.extend({ from_warehouse_id: z.number().int().positive(), to_warehouse_id: z.number().int().positive() }).parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  await withTx((c) => transferStock(c, { distributorId: d, productId: b.product_id, fromId: b.from_warehouse_id, toId: b.to_warehouse_id, qty: b.qty, actorId: d, note: b.note }));
  await audit(d, 'inventory.transfer', 'product', b.product_id, { from: b.from_warehouse_id, to: b.to_warehouse_id, qty: b.qty });
  res.status(201).json({ ok: true });
}));

const damagedBody = move.extend({ warehouse_id: z.number().int().positive().optional() });
const damaged = (kind: 'mark' | 'recover' | 'writeoff') => asyncHandler(async (req, res) => {
  const b = damagedBody.parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  await withTx(async (c) => {
    const o = { distributorId: d, productId: b.product_id, warehouseId: b.warehouse_id ?? await defaultWarehouse(c, d), qty: b.qty, actorId: d, note: b.note };
    if (kind === 'mark') await markDamaged(c, o); else if (kind === 'recover') await recoverDamaged(c, o); else await writeOffDamaged(c, o);
  });
  await audit(d, `inventory.damaged_${kind}`, 'product', b.product_id, { qty: b.qty, warehouse_id: b.warehouse_id ?? null });
  res.status(201).json({ ok: true });
});
inventoryRouter.post('/damaged', damaged('mark'));
inventoryRouter.post('/damaged/recover', damaged('recover'));
inventoryRouter.post('/damaged/write-off', damaged('writeoff'));

// ---- the books ----
inventoryRouter.get('/movements', asyncHandler(async (req, res) => {
  const qs = z.object({
    product_id: z.coerce.number().int().positive().optional(), warehouse_id: z.coerce.number().int().positive().optional(),
    before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  const where = ['m.distributor_id = ?']; const args: unknown[] = [req.auth!.userId];
  if (qs.product_id) { where.push('m.product_id = ?'); args.push(qs.product_id); }
  if (qs.warehouse_id) { where.push('m.warehouse_id = ?'); args.push(qs.warehouse_id); }
  if (qs.before) { where.push('m.id < ?'); args.push(qs.before); }
  const rows = await q<any>(pool, `SELECT m.id, m.product_id, p.name product, m.warehouse_id, w.name warehouse, m.delta, m.balance_after, m.reason, m.bucket, m.ref_order_id, m.note, u.name actor, m.created_at
    FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.actor_id
    WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, [...args, qs.limit + 1]);
  const page = rows.slice(0, qs.limit);
  res.json({ movements: page, next_before: rows.length > qs.limit ? page[page.length - 1].id : null });
}));

inventoryRouter.get('/reconciliation', asyncHandler(async (req, res) => {
  res.json(await reconcile(req.auth!.userId));
}));
