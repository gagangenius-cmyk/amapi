import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Conn, exec, pool, q, q1, withTx } from '../../db/pool';
import { AuthCtx, authenticate, idempotencyKey, requireRole } from '../../middleware/auth';
import { AppError, asyncHandler, forbidden, notFound } from '../../utils/errors';
import { fromPaise, withGst } from '../../utils/money';
import { idParam } from '../../utils/http';
import { assertPermission, assertSubscriptionActive, loadDistributor } from '../distributors/subscription';
import { notifyUsers, teamOf } from '../../services/notify';
import { allocateFefo, releaseAllocations } from '../catalog/batches';
import { reservedByProduct } from '../inventory/inventory.service';
import { displayName } from '../catalog/catalog.routes';
import { changeStock, loadTiers } from '../catalog/stock';
import { loadRules, resolvePrice } from '../pricing/resolver';
import { earnCommission, snapshotFor } from '../commission/commission.service';
import { postLedger } from '../ledger/ledger.service';
import { storeAccess } from '../retailers/access';

export const orderRouter = Router();
orderRouter.use(authenticate);

type Status = 'placed' | 'accepted' | 'dispatched' | 'out_for_delivery' | 'delivered' | 'rejected' | 'cancelled';

/** Allowed transitions and which actors may perform them. */
const TRANSITIONS: Record<Status, Partial<Record<Status, Array<'retailer' | 'distributor' | 'assignee'>>>> = {
  placed: { accepted: ['distributor'], rejected: ['distributor'], cancelled: ['retailer', 'distributor'] },
  accepted: { dispatched: ['distributor', 'assignee'], cancelled: ['distributor'] },
  dispatched: { out_for_delivery: ['distributor', 'assignee'] },
  out_for_delivery: { delivered: ['distributor', 'assignee'] },
  delivered: {}, rejected: {}, cancelled: {},
};

const present = (o: any, items?: any[]) => ({
  id: o.id, retailer_id: o.retailer_id, distributor_id: o.distributor_id, status: o.status, total: fromPaise(Number(o.total_paise)),
  is_out_of_hierarchy: !!o.is_out_of_hierarchy, commission_rate_bps: o.commission_rate_bps, assigned_employee_id: o.assigned_employee_id,
  created_at: o.created_at, invoice_no: o.invoice_no ?? null, is_adjusted: !!o.is_adjusted,
  ...(o.retailer_name !== undefined && { retailer_name: o.retailer_name, distributor_name: o.distributor_name, item_count: Number(o.item_count) }),
  ...(items && { items: items.map((i) => ({ product_id: i.product_id, name: i.name, qty: i.qty, ordered_qty: i.ordered_qty ?? i.qty, unit_price: fromPaise(Number(i.unit_price_paise)), gst_rate_bps: i.gst_rate_bps, line_total: fromPaise(Number(i.line_total_paise)),
    standard_unit_price: i.standard_unit_price_paise == null ? null : fromPaise(Number(i.standard_unit_price_paise)), price_list: i.price_list_name ?? null, price_basis: i.price_basis ?? null })) }),
});

orderRouter.post('/', requireRole('retailer'), asyncHandler(async (req, res) => {
  const b = z.object({
    distributor_id: z.number().int().positive(),
    items: z.array(z.object({ product_id: z.number().int().positive(), qty: z.number().int().min(1).max(100000) })).min(1).max(100),
  }).parse(req.body);
  const key = idempotencyKey(req);
  const retailerId = req.auth!.userId;
  // Fingerprint of what was asked for, so reusing a key for a DIFFERENT cart is rejected instead of silently returning the old order.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ d: b.distributor_id, i: [...b.items].sort((x, y) => x.product_id - y.product_id) })).digest('hex');
  const replay = (existing: any) => {
    if (existing.request_hash && existing.request_hash !== fingerprint)
      throw new AppError(422, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different order');
    return { order: existing, replayed: true };
  };

  const out = await withTx(async (c) => {
    const dup = await q1<any>(c, 'SELECT * FROM orders WHERE retailer_id = ? AND idempotency_key = ?', [retailerId, key]);
    if (dup) return replay(dup);

    const dist = await assertSubscriptionActive(c, b.distributor_id);
    const ids = [...new Set(b.items.map((i) => i.product_id))];
    if (ids.length !== b.items.length) throw new AppError(400, 'DUPLICATE_ITEM', 'Each product may appear once');
    const products = await q<any>(c, "SELECT * FROM products WHERE id IN (?) AND distributor_id = ? AND deleted_at IS NULL AND is_active = 1 AND review_status = 'approved' ORDER BY id FOR UPDATE", [ids, b.distributor_id]);   // locked: parallel orders for the same product queue up here
    if (products.length !== ids.length) throw new AppError(400, 'BAD_PRODUCT', 'Unknown or unavailable product');
    const byId = new Map(products.map((p) => [p.id, p]));
    // Stock already promised to orders waiting for acceptance is not available to this one (read under the lock above).
    const reserved = await reservedByProduct(c, ids, b.distributor_id, true);

    const tiers = await loadTiers(c, ids);
    const prof = await q1<any>(c, 'SELECT pincode FROM retailer_profiles WHERE user_id = ?', [retailerId]);
    const rules = await loadRules(c, { distributorId: b.distributor_id, retailerId, pincode: prof?.pincode, productIds: ids });
    let total = 0;
    const lines = b.items.map((i) => {
      const p = byId.get(i.product_id);
      if (i.qty < p.min_order_qty) throw new AppError(400, 'MIN_QTY', `Minimum order for ${p.name} is ${p.min_order_qty} ${p.unit}`);
      const available = p.stock_qty - (reserved.get(p.id) ?? 0);
      if (available < i.qty) throw new AppError(409, 'OUT_OF_STOCK', `Insufficient stock for ${p.name}`, { available: Math.max(0, available) });
      // quantity-break pricing: a bigger quantity can unlock a lower unit price
      // standard price and break, then any price list that applies to this retailer (see modules/pricing/resolver.ts)
      const priced = resolvePrice(Number(p.price_paise), tiers.get(p.id) ?? [], rules.get(p.id) ?? [], i.qty);
      const unit = priced.unit_paise;
      const line = withGst(unit * i.qty, p.gst_rate_bps);
      total += line;
      return { p, qty: i.qty, unit, line, priced };
    });

    // The link between them (locked, so parallel orders can not both slip under a credit limit).
    const rel = await q1<any>(c, 'SELECT id, status, balance_due_paise, credit_limit_paise FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? FOR UPDATE', [retailerId, b.distributor_id]);
    // Credit control: what they already owe + orders still waiting for acceptance + this order must fit the limit.
    if (rel?.status === 'active' && rel.credit_limit_paise != null) {
      const pending = Number((await q1<any>(c, "SELECT COALESCE(SUM(total_paise),0) t FROM orders WHERE retailer_id = ? AND distributor_id = ? AND status = 'placed' FOR UPDATE", [retailerId, b.distributor_id]))!.t); // locking read: sees orders committed while we waited for the lock
      const exposure = Number(rel.balance_due_paise) + pending + total;
      if (exposure > Number(rel.credit_limit_paise))
        throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', `This order would take you over the credit limit of ₹${fromPaise(Number(rel.credit_limit_paise))} set by the distributor. Pay some dues or order less.`, {
          credit_limit: fromPaise(Number(rel.credit_limit_paise)), balance_due: fromPaise(Number(rel.balance_due_paise)), pending_orders: fromPaise(pending),
        });
    }
    // Who may order: connected retailers, retailers the distributor invited, and (when switched on) retailers in a pincode it sells to.
    const access = await storeAccess(c, retailerId, b.distributor_id);
    if (!access) throw new AppError(403, 'NOT_SERVICEABLE', 'This distributor does not sell to you. Ask them to add you, or pick a distributor that serves your pincode.');
    if (access !== 'linked') {
      // placing an order is the retailer's own consent to deal with them
      if (rel) await exec(c, "UPDATE retailer_distributor_relations SET status = 'active' WHERE id = ?", [rel.id]);
      else await exec(c, "INSERT INTO retailer_distributor_relations (retailer_id, distributor_id, is_primary, status, requested_by) VALUES (?,?,0,'active','retailer')", [retailerId, b.distributor_id]);
    }
    // "In the hierarchy" = this distributor is the retailer's pinned one, or brought the retailer in (invited them).
    // Everything else is an outside order and carries platform commission. A retailer with nothing pinned yet gets this first supplier pinned.
    const primary = await q1<any>(c, "SELECT distributor_id FROM retailer_distributor_relations WHERE retailer_id = ? AND is_primary = 1 AND status = 'active'", [retailerId]);
    const relNow = (await q1<any>(c, 'SELECT requested_by FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ?', [retailerId, b.distributor_id]))!;
    let outOfHierarchy = false;
    if (!primary) await exec(c, 'UPDATE retailer_distributor_relations SET is_primary = 1 WHERE retailer_id = ? AND distributor_id = ?', [retailerId, b.distributor_id]);
    else outOfHierarchy = primary.distributor_id !== b.distributor_id && relNow.requested_by !== 'distributor';

    // Outside the hierarchy the order carries commission: fix the rule for each line now, so a later rule change cannot touch it.
    const commission = outOfHierarchy ? await snapshotFor(c, b.distributor_id, dist.commission_rate_bps, lines.map((l) => ({ id: l.p.id, category_id: l.p.category_id ?? null }))) : null;
    const o = await exec(c, 'INSERT INTO orders (retailer_id, distributor_id, total_paise, is_out_of_hierarchy, commission_rate_bps, idempotency_key, request_hash) VALUES (?,?,?,?,?,?,?)', [
      retailerId, b.distributor_id, total, outOfHierarchy ? 1 : 0, outOfHierarchy ? dist.commission_rate_bps : 0, key, fingerprint,
    ]);
    await exec(c, 'INSERT INTO order_items (order_id, product_id, name, qty, unit_price_paise, gst_rate_bps, line_total_paise, standard_unit_price_paise, price_list_id, price_list_name, price_basis, commission_mode, commission_value, commission_rule_id) VALUES ?', [
      lines.map((l) => { const cm = commission?.get(l.p.id); return [o.insertId, l.p.id, displayName(l.p).slice(0, 190), l.qty, l.unit, l.p.gst_rate_bps, l.line, l.priced.standard_paise, l.priced.list_id, l.priced.list_name, l.priced.basis, cm?.mode ?? null, cm?.value ?? null, cm?.rule_id ?? null]; }),
    ]);
    await exec(c, "INSERT INTO order_events (order_id, from_status, to_status, actor_id) VALUES (?,NULL,'placed',?)", [o.insertId, retailerId]);
    return { order: await q1<any>(c, 'SELECT * FROM orders WHERE id = ?', [o.insertId]), replayed: false };
  }).catch(async (e) => {
    if (e?.code === 'ER_DUP_ENTRY') return replay(await q1<any>(pool, 'SELECT * FROM orders WHERE retailer_id = ? AND idempotency_key = ?', [retailerId, key]));
    throw e;
  });
  const items = await q(pool, 'SELECT * FROM order_items WHERE order_id = ?', [out.order.id]);
  if (!out.replayed) teamOf(out.order.distributor_id).then((t) => notifyUsers(t, 'New order', `Order #${out.order.id} · ₹${fromPaise(Number(out.order.total_paise))}`, { type: 'order', id: out.order.id }));
  res.status(out.replayed ? 200 : 201).json({ replayed: out.replayed, order: present(out.order, items) });
}));

function scopeWhere(a: AuthCtx): [string, unknown[]] {
  if (a.role === 'retailer') return ['o.retailer_id = ?', [a.userId]];
  if (a.role === 'distributor') return ['o.distributor_id = ?', [a.userId]];
  if (a.role === 'employee') return ['o.distributor_id = ? AND o.assigned_employee_id = ?', [a.distributorId, a.userId]];
  throw forbidden();
}

orderRouter.get('/', asyncHandler(async (req, res) => {
  const [w, p] = scopeWhere(req.auth!);
  const qs = z.object({
    status: z.enum(['placed', 'accepted', 'dispatched', 'out_for_delivery', 'delivered', 'rejected', 'cancelled']).optional(),
    before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(100),
    outside: z.enum(['1']).optional(),   // only orders from retailers outside this distributor's hierarchy (commission orders)
  }).parse(req.query);
  const args: unknown[] = [...p];
  let extra = '';
  if (qs.status) { extra += ' AND o.status = ?'; args.push(qs.status); }
  if (qs.before) { extra += ' AND o.id < ?'; args.push(qs.before); }
  if (qs.outside) extra += ' AND o.is_out_of_hierarchy = 1';
  const rows = await q<any>(pool, `SELECT o.*, rp.shop_name AS retailer_name, dp.business_name AS distributor_name, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count FROM orders o JOIN retailer_profiles rp ON rp.user_id = o.retailer_id JOIN distributor_profiles dp ON dp.user_id = o.distributor_id WHERE ${w}${extra} ORDER BY o.id DESC LIMIT ?`, [...args, qs.limit + 1]);
  const page = rows.slice(0, qs.limit);
  // has_more / next_before let the app load older orders instead of silently stopping at the newest page
  res.json({ orders: page.map((r) => present(r)), has_more: rows.length > qs.limit, next_before: rows.length > qs.limit ? page[page.length - 1].id : null });
}));

orderRouter.get('/:id', asyncHandler(async (req, res) => {
  const [w, p] = scopeWhere(req.auth!);
  const o = await q1<any>(pool, `SELECT o.*, rp.shop_name AS retailer_name, dp.business_name AS distributor_name, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count FROM orders o JOIN retailer_profiles rp ON rp.user_id = o.retailer_id JOIN distributor_profiles dp ON dp.user_id = o.distributor_id WHERE o.id = ? AND ${w}`, [idParam(req), ...p]);
  if (!o) throw notFound('Order');
  const items = await q(pool, 'SELECT * FROM order_items WHERE order_id = ?', [o.id]);
  const events = await q(pool, 'SELECT from_status, to_status, actor_id, created_at FROM order_events WHERE order_id = ? ORDER BY id', [o.id]);
  res.json({ ...present(o, items), events });
}));


/** Indian financial year (1 Apr - 31 Mar) for "now" in IST, e.g. "2026-27". */
export function financialYear(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * GST rules need invoice numbers that are unique and consecutive per supplier per financial year.
 * The counter row is incremented inside the acceptance transaction, so a rolled-back acceptance leaves no gap.
 */
async function assignInvoiceNumber(c: Conn, orderId: number, distributorId: number) {
  const fy = financialYear();
  await exec(c, 'INSERT INTO invoice_counters (distributor_id, fy, last_no) VALUES (?,?,1) ON DUPLICATE KEY UPDATE last_no = last_no + 1', [distributorId, fy]);
  const row = await q1<{ last_no: number }>(c, 'SELECT last_no FROM invoice_counters WHERE distributor_id = ? AND fy = ?', [distributorId, fy]);
  await exec(c, 'UPDATE orders SET invoice_no = ? WHERE id = ?', [`${fy}/${String(row!.last_no).padStart(5, '0')}`, orderId]);
}

async function restoreStockAndReverseInvoice(c: Conn, o: any, actorId: number) {
  await releaseAllocations(c, o.id); // batches get their units back before the stock count rises
  const items = await q<any>(c, 'SELECT product_id, qty FROM order_items WHERE order_id = ? ORDER BY product_id', [o.id]);
  for (const i of items) await changeStock(c, { productId: i.product_id, distributorId: o.distributor_id, delta: i.qty, reason: 'order_cancelled', orderId: o.id, actorId });
  const inv = await q1<any>(c, "SELECT id FROM ledger_transactions WHERE order_id = ? AND type = 'invoice'", [o.id]);
  const alreadyReversed = inv && (await q1(c, 'SELECT 1 FROM ledger_transactions WHERE reversal_of = ?', [inv.id]));
  if (inv && !alreadyReversed) {
    await postLedger(c, {
      distributorId: o.distributor_id, retailerId: o.retailer_id, type: 'reversal', amountPaise: Number(o.total_paise), reversalOf: inv.id,
      createdBy: actorId, idempotencyKey: `cancel:order:${o.id}`, orderId: o.id, notes: 'Order cancelled',
    });
  }
}

/** Shrink an order's lines to what the distributor can ship; the invoice and stock then follow the reduced quantities. */
async function applyPartialAcceptance(c: Conn, o: any, adjust: { product_id: number; qty: number }[], actorId: number) {
  const lines = await q<any>(c, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id', [o.id]);
  const want = new Map(adjust.map((x) => [x.product_id, x.qty]));
  if (want.size !== adjust.length) throw new AppError(400, 'DUPLICATE_ITEM', 'Each product may appear once');
  for (const id of want.keys()) if (!lines.some((l) => l.product_id === id)) throw new AppError(400, 'BAD_PRODUCT', 'That product is not in this order');
  let total = 0; let changed = false;
  for (const l of lines) {
    const qty = want.get(l.product_id) ?? l.qty;
    if (qty > l.qty) throw new AppError(400, 'QTY_TOO_HIGH', `You cannot ship more than was ordered of ${l.name}`);
    const line = withGst(Number(l.unit_price_paise) * qty, l.gst_rate_bps);
    total += line;
    if (qty !== l.qty) {
      changed = true;
      await exec(c, 'UPDATE order_items SET ordered_qty = COALESCE(ordered_qty, qty), qty = ?, line_total_paise = ? WHERE id = ?', [qty, line, l.id]);
    }
  }
  if (total <= 0) throw new AppError(400, 'NOTHING_TO_SHIP', 'At least one item must be shipped. To refuse the whole order, reject it instead.');
  if (!changed) return;
  await exec(c, 'UPDATE orders SET total_paise = ?, is_adjusted = 1 WHERE id = ?', [total, o.id]);
  await exec(c, "INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?, 'order.partial_accept', 'order', ?, ?)", [actorId, o.id, JSON.stringify({ from_total_paise: Number(o.total_paise), to_total_paise: total })]);
  o.total_paise = total; // the invoice posted next uses the reduced total
}

orderRouter.post('/:id/transition', asyncHandler(async (req, res) => {
  const { to, items: adjust } = z.object({
    to: z.enum(['accepted', 'rejected', 'cancelled', 'dispatched', 'out_for_delivery', 'delivered']),
    // Partial fulfilment: when accepting, the distributor may ship less than was ordered (0 = cannot supply that line).
    items: z.array(z.object({ product_id: z.number().int().positive(), qty: z.number().int().min(0).max(100000) })).min(1).max(100).optional(),
  }).parse(req.body);
  if (adjust && to !== 'accepted') throw new AppError(400, 'VALIDATION', 'Quantities can only be adjusted when accepting an order');
  const a = req.auth!;
  if (a.role === 'admin') throw forbidden();

  const updated = await withTx(async (c) => {
    const o = await q1<any>(c, 'SELECT * FROM orders WHERE id = ? FOR UPDATE', [idParam(req)]);
    // Scope check: hide orders outside the caller's tenant.
    const inScope =
      o && ((a.role === 'retailer' && o.retailer_id === a.userId) ||
        ((a.role === 'distributor' || a.role === 'employee') && o.distributor_id === a.distributorId));
    if (!inScope) throw notFound('Order');

    const actors = TRANSITIONS[o.status as Status][to as Status];
    if (!actors) throw new AppError(409, 'BAD_TRANSITION', `Cannot move order from ${o.status} to ${to}`);
    const isAssignee = a.role === 'employee' && o.assigned_employee_id === a.userId;
    const allowed = (a.role === 'retailer' && actors.includes('retailer')) || (a.role === 'distributor' && actors.includes('distributor')) || (isAssignee && actors.includes('assignee'));
    if (!allowed) throw forbidden('You cannot perform this transition');

    if (a.role !== 'retailer') await assertSubscriptionActive(c, o.distributor_id);

    if (to === 'accepted' && adjust) await applyPartialAcceptance(c, o, adjust, a.userId);
    if (to === 'accepted') {
      const items = await q<any>(c, 'SELECT product_id, qty FROM order_items WHERE order_id = ? ORDER BY product_id', [o.id]);
      for (const i of items) {
        if (i.qty > 0) await allocateFefo(c, { productId: i.product_id, orderId: o.id, qty: i.qty });
        await changeStock(c, { productId: i.product_id, distributorId: o.distributor_id, delta: -i.qty, reason: 'order_accepted', orderId: o.id, actorId: a.userId });
      }
      await assignInvoiceNumber(c, o.id, o.distributor_id);
      // Only the explicit "khatabook disabled" setting skips the invoice; any other failure aborts the whole acceptance.
      const d = await loadDistributor(c, o.distributor_id);
      if (d.permissions.khatabook_enabled) {
        await postLedger(c, {
          distributorId: o.distributor_id, retailerId: o.retailer_id, type: 'invoice', amountPaise: Number(o.total_paise),
          createdBy: a.userId, idempotencyKey: `invoice:order:${o.id}`, orderId: o.id,
        });
      }
    }
    if (to === 'cancelled' && o.status === 'accepted') await restoreStockAndReverseInvoice(c, o, a.userId);

    await exec(c, 'UPDATE orders SET status = ? WHERE id = ?', [to, o.id]);
    await exec(c, 'INSERT INTO order_events (order_id, from_status, to_status, actor_id) VALUES (?,?,?,?)', [o.id, o.status, to, a.userId]);
    if (to === 'delivered') await earnCommission(c, o.id);
    return q1<any>(c, 'SELECT * FROM orders WHERE id = ?', [o.id]);
  });
  const label = to.replace(/_/g, ' ');
  if (a.role === 'retailer') teamOf(updated.distributor_id).then((t) => notifyUsers(t, `Order #${updated.id} ${label}`, 'Cancelled by retailer', { type: 'order', id: updated.id }));
  else notifyUsers([updated.retailer_id], `Order #${updated.id} ${label}`, updated.is_adjusted && to === 'accepted' ? `Partly accepted: new total ₹${fromPaise(Number(updated.total_paise))}` : 'Tap to view your order', { type: 'order', id: updated.id });
  res.json(present(updated));
}));

// Assign / reassign delivery employee. Allowed until the order is delivered.
orderRouter.post('/:id/assign', requireRole('distributor'), asyncHandler(async (req, res) => {
  const { employee_id } = z.object({ employee_id: z.number().int().positive() }).parse(req.body);
  const updated = await withTx(async (c) => {
    const o = await q1<any>(c, 'SELECT * FROM orders WHERE id = ? AND distributor_id = ? FOR UPDATE', [idParam(req), req.auth!.userId]);
    if (!o) throw notFound('Order');
    if (!['accepted', 'dispatched', 'out_for_delivery'].includes(o.status)) throw new AppError(409, 'BAD_STATE', 'Order is not in a deliverable state');
    await assertPermission(c, o.distributor_id, 'self_delivery');
    const e = await q1<any>(c, "SELECT id, is_available FROM users WHERE id = ? AND role = 'employee' AND owner_distributor_id = ? AND is_active = 1", [employee_id, req.auth!.userId]);
    if (!e) throw notFound('Employee');
    if (!e.is_available) throw new AppError(409, 'EMPLOYEE_UNAVAILABLE', 'That person is marked unavailable. Pick someone else, or mark them available again.');
    await exec(c, 'UPDATE orders SET assigned_employee_id = ? WHERE id = ?', [employee_id, o.id]);
    await exec(c, "INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?, 'order.assign', 'order', ?, ?)", [req.auth!.userId, o.id, JSON.stringify({ from: o.assigned_employee_id, to: employee_id })]);
    return q1<any>(c, 'SELECT * FROM orders WHERE id = ?', [o.id]);
  });
  notifyUsers([employee_id], 'Delivery assigned', `Order #${updated.id}`, { type: 'order', id: updated.id });
  res.json(present(updated));
}));
