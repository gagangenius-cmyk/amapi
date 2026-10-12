import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { companyPayment } from '../subscription/subscription.service';
import { createSettlement, dualControl, releaseEntries } from './commission.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-10-31').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Not a real date');
const money = (v: unknown) => fromPaise(Number(v ?? 0));

const presentSettlement = (s: any) => ({
  id: s.id, distributor_id: s.distributor_id, business_name: s.business_name ?? undefined, period_from: String(s.period_from).slice(0, 10), period_to: String(s.period_to).slice(0, 10),
  entry_count: s.entry_count, amount: money(s.amount_paise), status: s.status, created_at: s.created_at,
  approved_at: s.approved_at, paid_at: s.paid_at, payment_ref: s.payment_ref, note: s.note,
});
const entryOut = (e: any) => ({
  id: e.id, order_id: e.order_id, kind: e.kind, basis: money(e.basis_paise), mode: e.mode, value: e.mode === 'percent' ? Number(e.value) / 100 : money(e.value),
  amount: money(e.amount_paise), at: e.occurred_at, settlement_id: e.settlement_id, rule_id: e.rule_id, business_name: e.business_name ?? undefined,
});

// =============================================================================================
// Admin: rules, entries, settlement batches. Mounted inside the admin router (auth, role and 2FA already applied).
// =============================================================================================
export const adminCommissionRouter = Router();

// ---- rules ----
const ruleBody = z.object({
  distributor_id: z.number().int().positive().nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  product_id: z.number().int().positive().nullable().optional(),
  percent: z.number().min(0).max(50).optional(),
  fixed_per_unit: z.union([z.string(), z.number()]).optional(),
  priority: z.number().int().min(-1000).max(1000).default(0),
  valid_from: day.nullable().optional(), valid_to: day.nullable().optional(),
  is_active: z.boolean().default(true),
  note: z.string().trim().max(200).nullable().optional(),
}).superRefine((v, ctx) => {
  if ((v.percent === undefined) === (v.fixed_per_unit === undefined)) ctx.addIssue({ code: 'custom', path: ['percent'], message: 'Give either a percent or a fixed amount per unit' });
  if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'The end date is before the start date' });
});

const ruleOut = (r: any) => ({
  id: r.id, distributor_id: r.distributor_id, business_name: r.business_name ?? null, category_id: r.category_id, category: r.category ?? null, product_id: r.product_id, product: r.product ?? null,
  mode: r.mode, percent: r.mode === 'percent' ? Number(r.value) / 100 : null, fixed_per_unit: r.mode === 'fixed_unit' ? money(r.value) : null,
  priority: r.priority, valid_from: r.valid_from ? String(r.valid_from).slice(0, 10) : null, valid_to: r.valid_to ? String(r.valid_to).slice(0, 10) : null, is_active: !!r.is_active, note: r.note,
});
const RULE_SQL = `SELECT r.*, dp.business_name, c.name category, p.name product FROM commission_rules r
  LEFT JOIN distributor_profiles dp ON dp.user_id = r.distributor_id LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN products p ON p.id = r.product_id`;

adminCommissionRouter.get('/commission/rules', asyncHandler(async (_req, res) => {
  res.json({ rules: (await q<any>(pool, `${RULE_SQL} ORDER BY r.is_active DESC, r.id DESC`)).map(ruleOut) });
}));

async function validateRuleTargets(b: z.infer<typeof ruleBody>) {
  if (b.distributor_id && !(await q1(pool, 'SELECT 1 FROM distributor_profiles WHERE user_id = ?', [b.distributor_id]))) throw new AppError(400, 'BAD_DISTRIBUTOR', 'Unknown distributor');
  if (b.category_id && !(await q1(pool, 'SELECT 1 FROM categories WHERE id = ?', [b.category_id]))) throw new AppError(400, 'BAD_CATEGORY', 'Unknown category');
  if (b.product_id) {
    const p = await q1<any>(pool, 'SELECT distributor_id FROM products WHERE id = ? AND deleted_at IS NULL', [b.product_id]);
    if (!p) throw new AppError(400, 'BAD_PRODUCT', 'Unknown product');
    if (b.distributor_id && b.distributor_id !== p.distributor_id) throw new AppError(400, 'PRODUCT_MISMATCH', 'That product belongs to a different distributor');
  }
}
const valueOf = (b: z.infer<typeof ruleBody>) => {
  if (b.percent !== undefined) return { mode: 'percent' as const, value: Math.round(b.percent * 100) };
  const s = String(b.fixed_per_unit);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new AppError(400, 'BAD_AMOUNT', 'Fixed amount looks like 12 or 12.50');
  const [r, p = ''] = s.split('.');
  return { mode: 'fixed_unit' as const, value: Number(r) * 100 + Number(p.padEnd(2, '0')) };
};

adminCommissionRouter.post('/commission/rules', asyncHandler(async (req, res) => {
  const b = ruleBody.parse(req.body);
  await validateRuleTargets(b);
  const v = valueOf(b);
  const r = await exec(pool, `INSERT INTO commission_rules (distributor_id, category_id, product_id, mode, value, priority, valid_from, valid_to, is_active, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [b.distributor_id ?? null, b.category_id ?? null, b.product_id ?? null, v.mode, v.value, b.priority, b.valid_from ?? null, b.valid_to ?? null, b.is_active ? 1 : 0, b.note ?? null, req.auth!.userId]);
  await audit(req.auth!.userId, 'commission.rule_create', 'commission_rule', r.insertId, { ...b, ...v });
  res.status(201).json(ruleOut((await q1<any>(pool, `${RULE_SQL} WHERE r.id = ?`, [r.insertId]))));
}));

adminCommissionRouter.put('/commission/rules/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM commission_rules WHERE id = ?', [id]);
  if (!cur) throw notFound('Rule');
  const base = {
    distributor_id: cur.distributor_id, category_id: cur.category_id, product_id: cur.product_id, priority: cur.priority,
    valid_from: cur.valid_from ? String(cur.valid_from).slice(0, 10) : null, valid_to: cur.valid_to ? String(cur.valid_to).slice(0, 10) : null, is_active: !!cur.is_active, note: cur.note,
    ...(cur.mode === 'percent' ? { percent: Number(cur.value) / 100 } : { fixed_per_unit: fromPaise(cur.value) }),
  };
  const input: Record<string, unknown> = z.object({}).passthrough().parse(req.body ?? {});
  // switching between percent and fixed: whichever is given replaces the other
  if ('percent' in input) delete (base as any).fixed_per_unit; if ('fixed_per_unit' in input) delete (base as any).percent;
  const b = ruleBody.parse({ ...base, ...input });
  await validateRuleTargets(b);
  const v = valueOf(b);
  await exec(pool, 'UPDATE commission_rules SET distributor_id=?, category_id=?, product_id=?, mode=?, value=?, priority=?, valid_from=?, valid_to=?, is_active=?, note=? WHERE id=?',
    [b.distributor_id ?? null, b.category_id ?? null, b.product_id ?? null, v.mode, v.value, b.priority, b.valid_from ?? null, b.valid_to ?? null, b.is_active ? 1 : 0, b.note ?? null, id]);
  await audit(req.auth!.userId, 'commission.rule_update', 'commission_rule', id, { before: { mode: cur.mode, value: cur.value, is_active: !!cur.is_active }, after: { ...b, ...v } });
  res.json(ruleOut((await q1<any>(pool, `${RULE_SQL} WHERE r.id = ?`, [id]))));
}));

// A rule is a decision other people relied on: it is switched off, never erased (past orders keep their snapshot either way).
adminCommissionRouter.delete('/commission/rules/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const r = await exec(pool, 'UPDATE commission_rules SET is_active = 0 WHERE id = ?', [id]);
  if (!r.affectedRows) throw notFound('Rule');
  await audit(req.auth!.userId, 'commission.rule_off', 'commission_rule', id);
  res.status(204).end();
}));

// ---- what is owed ----
adminCommissionRouter.get('/commission/summary', asyncHandler(async (_req, res) => {
  const rows = await q<any>(pool, `SELECT e.distributor_id, dp.business_name, COUNT(*) entries, COALESCE(SUM(e.amount_paise),0) net,
      COALESCE(SUM(CASE WHEN e.amount_paise > 0 THEN e.amount_paise END),0) earned, COALESCE(SUM(CASE WHEN e.amount_paise < 0 THEN e.amount_paise END),0) reversed,
      MIN(e.occurred_at) oldest
    FROM commission_entries e JOIN distributor_profiles dp ON dp.user_id = e.distributor_id WHERE e.settlement_id IS NULL
    GROUP BY e.distributor_id, dp.business_name ORDER BY net DESC`);
  const open = await q1<any>(pool, "SELECT COALESCE(SUM(amount_paise),0) t FROM commission_settlements WHERE status IN ('draft','approved')");
  res.json({
    unsettled: rows.map((r) => ({ distributor_id: r.distributor_id, business_name: r.business_name, entries: Number(r.entries), earned: money(r.earned), reversed: money(r.reversed), net: money(r.net), oldest: r.oldest })),
    unsettled_total: money(rows.reduce((s, r) => s + Number(r.net), 0)),
    awaiting_payment: money(open!.t),
  });
}));

adminCommissionRouter.get('/commission/entries', asyncHandler(async (req, res) => {
  const qs = z.object({ distributor_id: z.coerce.number().int().positive().optional(), settlement_id: z.coerce.number().int().positive().optional(),
    settled: z.enum(['0', '1']).optional(), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  const where = ['1=1']; const args: unknown[] = [];
  if (qs.distributor_id) { where.push('e.distributor_id = ?'); args.push(qs.distributor_id); }
  if (qs.settlement_id) { where.push('e.settlement_id = ?'); args.push(qs.settlement_id); }
  if (qs.settled === '0') where.push('e.settlement_id IS NULL'); if (qs.settled === '1') where.push('e.settlement_id IS NOT NULL');
  if (qs.before) { where.push('e.id < ?'); args.push(qs.before); }
  const rows = await q<any>(pool, `SELECT e.*, dp.business_name FROM commission_entries e JOIN distributor_profiles dp ON dp.user_id = e.distributor_id WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`, [...args, qs.limit + 1]);
  const page = rows.slice(0, qs.limit);
  res.json({ entries: page.map(entryOut), next_before: rows.length > qs.limit ? page[page.length - 1].id : null });
}));

// ---- settlement batches ----
adminCommissionRouter.get('/commission/settlements', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['draft', 'approved', 'paid', 'cancelled']).optional() }).parse(req.query);
  const rows = await q<any>(pool, `SELECT s.*, dp.business_name FROM commission_settlements s JOIN distributor_profiles dp ON dp.user_id = s.distributor_id
    ${status ? 'WHERE s.status = ?' : ''} ORDER BY s.id DESC LIMIT 100`, status ? [status] : []);
  res.json({ settlements: rows.map(presentSettlement), dual_control: await dualControl() });
}));

adminCommissionRouter.post('/commission/settlements', asyncHandler(async (req, res) => {
  const b = z.object({ distributor_id: z.number().int().positive(), from: day, to: day }).refine((v) => v.to >= v.from, 'The end date is before the start date').parse(req.body);
  if (!(await q1(pool, 'SELECT 1 FROM distributor_profiles WHERE user_id = ?', [b.distributor_id]))) throw new AppError(404, 'NOT_FOUND', 'Distributor not found');
  const id = await withTx((c) => createSettlement(c, { distributorId: b.distributor_id, from: b.from, to: b.to, createdBy: req.auth!.userId }));
  await audit(req.auth!.userId, 'commission.settlement_create', 'commission_settlement', id, b);
  const s = (await q1<any>(pool, 'SELECT s.*, dp.business_name FROM commission_settlements s JOIN distributor_profiles dp ON dp.user_id = s.distributor_id WHERE s.id = ?', [id]))!;
  res.status(201).json(presentSettlement(s));
}));

adminCommissionRouter.get('/commission/settlements/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const s = await q1<any>(pool, 'SELECT s.*, dp.business_name FROM commission_settlements s JOIN distributor_profiles dp ON dp.user_id = s.distributor_id WHERE s.id = ?', [id]);
  if (!s) throw notFound('Settlement');
  const entries = await q<any>(pool, 'SELECT e.* FROM commission_entries e WHERE e.settlement_id = ? ORDER BY e.id', [id]);
  res.json({ ...presentSettlement(s), entries: entries.map(entryOut) });
}));

/** One transition at a time, from exactly one state, so a double tap or a retry cannot do it twice. */
async function transition(id: number, from: string[], to: string, set: string, args: unknown[]) {
  const r = await exec(pool, `UPDATE commission_settlements SET status = ?, ${set} WHERE id = ? AND status IN (?)`, [to, ...args, id, from]);
  if (r.affectedRows) return;
  const cur = await q1<any>(pool, 'SELECT status FROM commission_settlements WHERE id = ?', [id]);
  if (!cur) throw notFound('Settlement');
  throw new AppError(409, 'BAD_STATE', `This settlement is ${cur.status}`);
}

adminCommissionRouter.post('/commission/settlements/:id/approve', asyncHandler(async (req, res) => {
  const id = idParam(req);
  await transition(id, ['draft'], 'approved', 'approved_by = ?, approved_at = UTC_TIMESTAMP()', [req.auth!.userId]);
  await audit(req.auth!.userId, 'commission.settlement_approve', 'commission_settlement', id);
  const s = (await q1<any>(pool, 'SELECT * FROM commission_settlements WHERE id = ?', [id]))!;
  const pay = await companyPayment();
  notifyUsers([s.distributor_id], 'Commission statement', `₹${money(s.amount_paise)} commission for ${String(s.period_from).slice(0, 10)} to ${String(s.period_to).slice(0, 10)}${pay.upi_id ? ` is payable to ${pay.upi_id}` : ' is payable'}.`, { type: 'commission', id });
  res.json({ id, status: 'approved' });
}));

adminCommissionRouter.post('/commission/settlements/:id/pay', asyncHandler(async (req, res) => {
  const { reference } = z.object({ reference: z.string().trim().min(3).max(60) }).parse(req.body);
  const id = idParam(req);
  const s = await q1<any>(pool, 'SELECT * FROM commission_settlements WHERE id = ?', [id]);
  if (!s) throw notFound('Settlement');
  // two-person rule for money: whoever prepared the statement is not the one who confirms it was paid
  if ((await dualControl()) && s.created_by === req.auth!.userId) throw new AppError(403, 'DUAL_CONTROL', 'A different admin must confirm this payment');
  await transition(id, ['approved'], 'paid', 'paid_by = ?, paid_at = UTC_TIMESTAMP(), payment_ref = ?', [req.auth!.userId, reference]);
  await audit(req.auth!.userId, 'commission.settlement_paid', 'commission_settlement', id, { reference });
  notifyUsers([s.distributor_id], 'Commission payment received', `Thank you. Reference ${reference}.`, { type: 'commission', id });
  res.json({ id, status: 'paid' });
}));

// Cancelling a statement that is not paid frees its entries to be settled again.
adminCommissionRouter.post('/commission/settlements/:id/cancel', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
  const id = idParam(req);
  await withTx(async (c) => {
    const r = await exec(c, "UPDATE commission_settlements SET status = 'cancelled', note = ? WHERE id = ? AND status IN ('draft','approved')", [note, id]);
    if (!r.affectedRows) {
      const cur = await q1<any>(c, 'SELECT status FROM commission_settlements WHERE id = ?', [id]);
      if (!cur) throw notFound('Settlement');
      throw new AppError(409, 'BAD_STATE', `This settlement is ${cur.status}`);
    }
    await releaseEntries(c, id);
  });
  await audit(req.auth!.userId, 'commission.settlement_cancel', 'commission_settlement', id, { note });
  res.json({ id, status: 'cancelled' });
}));

adminCommissionRouter.put('/commission/settings', asyncHandler(async (req, res) => {
  const b = z.object({ settlement_dual_control: z.boolean() }).parse(req.body);
  await exec(pool, "INSERT INTO platform_settings (name, value) VALUES ('settlement_dual_control', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [b.settlement_dual_control ? '1' : '0']);
  await audit(req.auth!.userId, 'commission.dual_control', 'settings', null, b);
  res.json(b);
}));

// =============================================================================================
// Distributor: what I owe and what I have paid
// =============================================================================================
export const distributorCommissionRouter = Router();
distributorCommissionRouter.use(authenticate, requireRole('distributor'));

distributorCommissionRouter.get('/', asyncHandler(async (req, res) => {
  const d = req.auth!.userId;
  const open = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) net FROM commission_entries WHERE distributor_id = ? AND settlement_id IS NULL`, [d]))!;
  const rows = await q<any>(pool, "SELECT * FROM commission_settlements WHERE distributor_id = ? AND status <> 'draft' ORDER BY id DESC LIMIT 50", [d]);
  const entries = await q<any>(pool, 'SELECT * FROM commission_entries WHERE distributor_id = ? ORDER BY id DESC LIMIT 30', [d]);
  const due = rows.filter((s) => s.status === 'approved').reduce((n, s) => n + Number(s.amount_paise), 0);
  const pay = await companyPayment();
  res.json({
    accruing: { entries: Number(open.n), amount: money(open.net) },
    payable: money(due), pay_to: due > 0 ? { upi_id: pay.upi_id, payee: pay.payee } : null,
    settlements: rows.map((s) => presentSettlement(s)),
    recent_entries: entries.map(entryOut),
  });
}));
