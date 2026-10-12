import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, idempotencyKey, requireRole } from '../../middleware/auth';
import { notifyUsers, teamOf } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise, withGst } from '../../utils/money';
import { changeStock } from '../catalog/stock';
import { assertSubscriptionActive, loadDistributor } from '../distributors/subscription';
import { postLedger } from '../ledger/ledger.service';

/**
 * Returns: the retailer asks, the distributor approves or rejects.
 * Approving is one transaction: credit note in the khata (and optionally the goods back into stock).
 */
export const returnsRouter = Router();
returnsRouter.use(authenticate);

export const RETURN_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS ?? 15);

/** True while a return can still be requested for an order delivered at `deliveredAt`. */
export const withinReturnWindow = (deliveredAt: number, now = Date.now()) => now - deliveredAt <= RETURN_WINDOW_DAYS * 86400_000;

const present = (r: any, items?: any[]) => ({
  id: r.id, order_id: r.order_id, status: r.status, reason: r.reason, total: fromPaise(Number(r.total_paise)), restock: !!r.restock,
  resolution_note: r.resolution_note, created_at: r.created_at, resolved_at: r.resolved_at,
  ...(r.shop_name !== undefined && { shop_name: r.shop_name, business_name: r.business_name }),
  ...(items && { items: items.map((i) => ({ product_id: i.product_id, name: i.name, qty: i.qty, unit_price: fromPaise(Number(i.unit_price_paise)), line_total: fromPaise(Number(i.line_total_paise)) })) }),
});

returnsRouter.post('/', requireRole('retailer'), asyncHandler(async (req, res) => {
  const b = z.object({
    order_id: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
    items: z.array(z.object({ product_id: z.number().int().positive(), qty: z.number().int().min(1).max(100000) })).min(1).max(100),
  }).parse(req.body);
  const key = idempotencyKey(req);
  const retailerId = req.auth!.userId;
  if (new Set(b.items.map((i) => i.product_id)).size !== b.items.length) throw new AppError(400, 'DUPLICATE_ITEM', 'Each product may appear once');

  const out = await withTx(async (c) => {
    const dup = await q1<any>(c, 'SELECT * FROM order_returns WHERE retailer_id = ? AND idempotency_key = ?', [retailerId, key]);
    if (dup) return { ret: dup, replayed: true };
    const o = await q1<any>(c, 'SELECT * FROM orders WHERE id = ? AND retailer_id = ? FOR UPDATE', [b.order_id, retailerId]);
    if (!o) throw notFound('Order');
    if (o.status !== 'delivered') throw new AppError(409, 'NOT_DELIVERED', 'Only delivered orders can be returned');
    const ev = await q1<any>(c, "SELECT created_at FROM order_events WHERE order_id = ? AND to_status = 'delivered' ORDER BY id DESC LIMIT 1", [o.id]);
    const deliveredAt = ev ? +new Date(ev.created_at) : +new Date(o.created_at);
    if (!withinReturnWindow(deliveredAt))
      throw new AppError(409, 'RETURN_WINDOW_CLOSED', `Returns are accepted within ${RETURN_WINDOW_DAYS} days of delivery`);

    const lines = await q<any>(c, 'SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    const already = await q<any>(c, `SELECT ri.product_id, SUM(ri.qty) n FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
      WHERE r.order_id = ? AND r.status <> 'rejected' GROUP BY ri.product_id`, [o.id]);
    const returned = new Map<number, number>(already.map((a) => [a.product_id, Number(a.n)]));

    let total = 0;
    const rows = b.items.map((i) => {
      const line = lines.find((l) => l.product_id === i.product_id);
      if (!line) throw new AppError(400, 'BAD_PRODUCT', 'That product is not in this order');
      const left = line.qty - (returned.get(i.product_id) ?? 0);
      if (i.qty > left) throw new AppError(409, 'RETURN_TOO_MANY', `You can return at most ${left} of ${line.name}`);
      const amount = withGst(Number(line.unit_price_paise) * i.qty, line.gst_rate_bps);
      total += amount;
      return { line, qty: i.qty, amount };
    });

    const r = await exec(c, 'INSERT INTO order_returns (order_id, retailer_id, distributor_id, reason, total_paise, idempotency_key) VALUES (?,?,?,?,?,?)', [o.id, retailerId, o.distributor_id, b.reason, total, key]);
    await exec(c, 'INSERT INTO order_return_items (return_id, product_id, name, qty, unit_price_paise, gst_rate_bps, line_total_paise) VALUES ?', [
      rows.map((x) => [r.insertId, x.line.product_id, x.line.name, x.qty, x.line.unit_price_paise, x.line.gst_rate_bps, x.amount]),
    ]);
    return { ret: await q1<any>(c, 'SELECT * FROM order_returns WHERE id = ?', [r.insertId]), replayed: false };
  }).catch(async (e) => {
    if (e?.code === 'ER_DUP_ENTRY') return { ret: await q1<any>(pool, 'SELECT * FROM order_returns WHERE retailer_id = ? AND idempotency_key = ?', [retailerId, key]), replayed: true };
    throw e;
  });
  const items = await q(pool, 'SELECT * FROM order_return_items WHERE return_id = ?', [out.ret.id]);
  if (!out.replayed) {
    await audit(retailerId, 'return.request', 'order', out.ret.order_id, { return_id: out.ret.id, total_paise: Number(out.ret.total_paise) });
    teamOf(out.ret.distributor_id).then((t) => notifyUsers(t, 'Return requested', `Order #${out.ret.order_id} · ₹${fromPaise(Number(out.ret.total_paise))}`, { type: 'return', id: out.ret.id }));
  }
  res.status(out.replayed ? 200 : 201).json({ replayed: out.replayed, return: present(out.ret, items) });
}));

returnsRouter.get('/', requireRole('retailer', 'distributor', 'employee'), asyncHandler(async (req, res) => {
  const a = req.auth!;
  const qs = z.object({ status: z.enum(['requested', 'approved', 'rejected']).optional(), order_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const where = [a.role === 'retailer' ? 'r.retailer_id = ?' : 'r.distributor_id = ?'];
  const args: unknown[] = [a.role === 'retailer' ? a.userId : a.distributorId];
  if (qs.status) { where.push('r.status = ?'); args.push(qs.status); }
  if (qs.order_id) { where.push('r.order_id = ?'); args.push(qs.order_id); }
  const rows = await q<any>(pool, `SELECT r.*, rp.shop_name, dp.business_name FROM order_returns r
    JOIN retailer_profiles rp ON rp.user_id = r.retailer_id JOIN distributor_profiles dp ON dp.user_id = r.distributor_id
    WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 100`, args);
  const items = rows.length ? await q<any>(pool, 'SELECT * FROM order_return_items WHERE return_id IN (?)', [rows.map((r) => r.id)]) : [];
  res.json({ returns: rows.map((r) => present(r, items.filter((i) => i.return_id === r.id))) });
}));

returnsRouter.post('/:id/resolve', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = z.object({
    action: z.enum(['approve', 'reject']), restock: z.boolean().default(true),
    note: z.string().trim().max(500).optional(),
  }).parse(req.body);
  if (b.action === 'reject' && !b.note) throw new AppError(400, 'NOTE_REQUIRED', 'Say why the return is rejected');
  const actor = req.auth!.userId;

  const done = await withTx(async (c) => {
    const r = await q1<any>(c, 'SELECT * FROM order_returns WHERE id = ? AND distributor_id = ? FOR UPDATE', [idParam(req), actor]);
    if (!r) throw notFound('Return');
    if (r.status !== 'requested') throw new AppError(409, 'ALREADY_RESOLVED', 'This return was already answered');
    await assertSubscriptionActive(c, actor);
    if (b.action === 'approve') {
      const items = await q<any>(c, 'SELECT * FROM order_return_items WHERE return_id = ? ORDER BY product_id', [r.id]);
      if (b.restock) for (const i of items) await changeStock(c, { productId: i.product_id, distributorId: actor, delta: i.qty, reason: 'customer_return', orderId: r.order_id, actorId: actor, note: `Return #${r.id}` });
      if ((await loadDistributor(c, actor)).permissions.khatabook_enabled)
        await postLedger(c, { distributorId: actor, retailerId: r.retailer_id, type: 'credit_note', amountPaise: Number(r.total_paise), createdBy: actor, idempotencyKey: `return:${r.id}`, orderId: r.order_id, notes: `Return #${r.id}: ${r.reason}`.slice(0, 500) });
    }
    await exec(c, 'UPDATE order_returns SET status = ?, restock = ?, resolution_note = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP() WHERE id = ?', [
      b.action === 'approve' ? 'approved' : 'rejected', b.action === 'approve' && b.restock ? 1 : 0, b.note ?? null, actor, r.id,
    ]);
    return q1<any>(c, 'SELECT * FROM order_returns WHERE id = ?', [r.id]);
  });
  await audit(actor, `return.${b.action}`, 'order', done.order_id, { return_id: done.id });
  notifyUsers([done.retailer_id], b.action === 'approve' ? 'Return approved' : 'Return rejected', b.action === 'approve' ? `₹${fromPaise(Number(done.total_paise))} credited to your khata` : (b.note ?? ''), { type: 'return', id: done.id });
  res.json(present(done));
}));
