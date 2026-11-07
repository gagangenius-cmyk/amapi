import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { AppError, asyncHandler, forbidden, notFound } from '../../utils/errors';
import { fromPaise } from '../../utils/money';
import { idParam } from '../../utils/http';
import { audit } from '../../utils/audit';
import { notifyUsers } from '../../services/notify';

/** Staged payments on one order: "30% advance, 70% on delivery". Mounted at /orders/:id/milestones. */
export const milestoneRouter = Router({ mergeParams: true });

const EVENTS = ['order', 'accepted', 'dispatched', 'delivered'] as const;
type Ev = (typeof EVENTS)[number];
/** Which order statuses mean a due-event has happened. */
const REACHED: Record<Ev, string[]> = {
  order: ['placed', 'accepted', 'dispatched', 'out_for_delivery', 'delivered'],
  accepted: ['accepted', 'dispatched', 'out_for_delivery', 'delivered'],
  dispatched: ['dispatched', 'out_for_delivery', 'delivered'],
  delivered: ['delivered'],
};

const planSchema = z.object({
  milestones: z.array(z.object({
    label: z.string().trim().min(1).max(60),
    percent: z.coerce.number().positive().max(100),
    due_event: z.enum(EVENTS).default('order'),
  })).min(1).max(6),
});

const PRESETS = [
  { name: 'Full payment on order', milestones: [{ label: 'Full payment', percent: 100, due_event: 'order' }] },
  { name: '30% advance, 70% on delivery', milestones: [{ label: 'Advance', percent: 30, due_event: 'order' }, { label: 'On delivery', percent: 70, due_event: 'delivered' }] },
  { name: '50% advance, 50% on delivery', milestones: [{ label: 'Advance', percent: 50, due_event: 'order' }, { label: 'On delivery', percent: 50, due_event: 'delivered' }] },
];

/** Splits the total by share; any rounding remainder goes to the last milestone so the parts always add up to the total. */
export function splitAmounts(totalPaise: number, bps: number[]): number[] {
  const parts = bps.map((b) => Math.floor((totalPaise * b) / 10000));
  parts[parts.length - 1] += totalPaise - parts.reduce((s, n) => s + n, 0);
  return parts;
}

async function loadOrder(req: any) {
  const id = idParam(req); const a = req.auth!;
  const o = await q1<any>(pool, 'SELECT id, retailer_id, distributor_id, status, total_paise, assigned_employee_id FROM orders WHERE id = ?', [id]);
  if (!o) throw notFound('Order');
  const isDist = a.role === 'distributor' && a.userId === o.distributor_id;
  const isEmployee = a.role === 'employee' && a.distributorId === o.distributor_id;
  const isRetailer = a.role === 'retailer' && a.userId === o.retailer_id;
  if (!isDist && !isEmployee && !isRetailer && a.role !== 'admin') throw notFound('Order'); // other people's orders look like they do not exist
  return { o, isDist };
}

async function present(o: any) {
  const rows = await q<any>(pool, 'SELECT * FROM order_milestones WHERE order_id = ? ORDER BY seq', [o.id]);
  const amounts = rows.length ? splitAmounts(Number(o.total_paise), rows.map((r) => r.pct_bps)) : [];
  const milestones = rows.map((r, i) => ({
    seq: r.seq, label: r.label, percent: r.pct_bps / 100, due_event: r.due_event as Ev, amount: fromPaise(amounts[i]),
    status: r.status === 'paid' ? 'paid' : REACHED[r.due_event as Ev].includes(o.status) ? 'due' : 'upcoming',
    paid_at: r.paid_at, method: r.method, reference: r.reference,
  }));
  const paid = rows.reduce((s, r, i) => s + (r.status === 'paid' ? amounts[i] : 0), 0);
  return { order_id: o.id, total: fromPaise(Number(o.total_paise)), paid: fromPaise(paid), remaining: fromPaise(Number(o.total_paise) - paid), milestones, presets: PRESETS };
}

milestoneRouter.get('/', asyncHandler(async (req, res) => { res.json(await present((await loadOrder(req)).o)); }));

// The distributor sets (or changes) the schedule. Once any milestone is paid the schedule is locked, so history cannot be rewritten.
milestoneRouter.put('/', asyncHandler(async (req, res) => {
  const { o, isDist } = await loadOrder(req);
  if (!isDist) throw forbidden('Only the distributor can set a payment schedule');
  if (['rejected', 'cancelled'].includes(o.status)) throw new AppError(409, 'ORDER_CLOSED', 'This order is closed');
  const b = planSchema.parse(req.body);
  const bps = b.milestones.map((m) => Math.round(m.percent * 100));
  if (bps.reduce((s, n) => s + n, 0) !== 10000) throw new AppError(400, 'PERCENT_TOTAL', 'The percentages must add up to exactly 100');
  await withTx(async (c) => {
    if (await q1(c, "SELECT 1 FROM order_milestones WHERE order_id = ? AND status = 'paid' FOR UPDATE", [o.id])) throw new AppError(409, 'MILESTONE_PAID', 'A milestone is already paid, so the schedule can no longer be changed');
    await exec(c, 'DELETE FROM order_milestones WHERE order_id = ?', [o.id]);
    for (let i = 0; i < b.milestones.length; i++) {
      await exec(c, 'INSERT INTO order_milestones (order_id, seq, label, pct_bps, due_event) VALUES (?,?,?,?,?)', [o.id, i + 1, b.milestones[i].label, bps[i], b.milestones[i].due_event]);
    }
  });
  await audit(req.auth!.userId, 'order.milestones_set', 'order', o.id, { milestones: b.milestones });
  notifyUsers([o.retailer_id], 'Payment schedule set', `Order #${o.id} will be paid in ${b.milestones.length} part${b.milestones.length > 1 ? 's' : ''}. Tap to see the dates.`, { type: 'order', order_id: o.id });
  res.json(await present(o));
}));

const paySchema = z.object({ method: z.enum(['upi', 'bank', 'cheque', 'cash']).optional(), reference: z.string().trim().max(80).optional() });

milestoneRouter.post('/:seq/paid', asyncHandler(async (req, res) => {
  const { o, isDist } = await loadOrder(req);
  if (!isDist) throw forbidden('Only the distributor can mark a payment received');
  const seq = Number(req.params.seq); const b = paySchema.parse(req.body ?? {});
  const m = await q1<any>(pool, 'SELECT * FROM order_milestones WHERE order_id = ? AND seq = ?', [o.id, seq]);
  if (!m) throw notFound('Payment milestone');
  if (m.status !== 'paid') {
    await exec(pool, "UPDATE order_milestones SET status = 'paid', paid_at = UTC_TIMESTAMP(), paid_by = ?, method = ?, reference = ? WHERE id = ? AND status = 'pending'", [req.auth!.userId, b.method ?? null, b.reference ?? null, m.id]);
    await audit(req.auth!.userId, 'order.milestone_paid', 'order', o.id, { seq, method: b.method ?? null });
    notifyUsers([o.retailer_id], 'Payment received', `${m.label} for order #${o.id} is marked paid.`, { type: 'order', order_id: o.id });
  }
  res.json(await present(o));
}));

// Undo a mistake: back to pending.
milestoneRouter.delete('/:seq/paid', asyncHandler(async (req, res) => {
  const { o, isDist } = await loadOrder(req);
  if (!isDist) throw forbidden('Only the distributor can change this');
  const r = await exec(pool, "UPDATE order_milestones SET status = 'pending', paid_at = NULL, paid_by = NULL, method = NULL, reference = NULL WHERE order_id = ? AND seq = ?", [o.id, Number(req.params.seq)]);
  if (!r.affectedRows) throw notFound('Payment milestone');
  await audit(req.auth!.userId, 'order.milestone_unpaid', 'order', o.id, { seq: Number(req.params.seq) });
  res.json(await present(o));
}));
