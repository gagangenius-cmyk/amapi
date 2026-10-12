import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1 } from '../../db/pool';
import { authenticate, invalidateUser, requireRole, requireTwoFactor } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { reconcile } from '../collections/collections.routes';
import { DEFAULT_PERMISSIONS, PERMISSION_CATALOG } from '../distributors/subscription';
import { afterConfirm, companyPayment, confirmSubscriptionPayment } from '../subscription/subscription.service';
import { notifyUsers } from '../../services/notify';
import { toPaise } from '../../utils/money';
import { withTx } from '../../db/pool';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'), requireTwoFactor);

adminRouter.get('/distributors', asyncHandler(async (_req, res) => {
  const rows = await q<any>(pool, `
    SELECT dp.user_id id, dp.business_name, dp.plan_name, u.phone, dp.subscription_ends_at, dp.permissions, dp.commission_rate_bps,
      (SELECT COUNT(*) FROM retailer_distributor_relations r WHERE r.distributor_id = dp.user_id) retailers,
      (SELECT COUNT(*) FROM orders o WHERE o.distributor_id = dp.user_id) orders
    FROM distributor_profiles dp JOIN users u ON u.id = dp.user_id ORDER BY dp.subscription_ends_at`);
  res.json({ permission_catalog: PERMISSION_CATALOG, distributors: rows.map((r) => ({ ...r, permissions: { ...DEFAULT_PERMISSIONS, ...JSON.parse(r.permissions) }, retailers: Number(r.retailers), orders: Number(r.orders) })) });
}));

// Orders placed with non-pinned distributors, for commission tracking.
adminRouter.get('/commissions', asyncHandler(async (_req, res) => {
  const rows = await q<any>(pool, `
    SELECT o.distributor_id, dp.business_name, COUNT(*) orders, SUM(o.total_paise) gross_paise,
      SUM(ROUND(o.total_paise * o.commission_rate_bps / 10000)) commission_paise
    FROM orders o JOIN distributor_profiles dp ON dp.user_id = o.distributor_id
    WHERE o.is_out_of_hierarchy = 1 AND o.status = 'delivered' GROUP BY o.distributor_id, dp.business_name`);
  res.json({ commissions: rows.map((r) => ({ ...r, orders: Number(r.orders), gross_paise: Number(r.gross_paise), commission_paise: Number(r.commission_paise) })) });
}));

// Platform KPIs for the console header.
adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const users = await q<any>(pool, "SELECT role, COUNT(*) n, SUM(is_active = 0) inactive FROM users GROUP BY role");
  const o = (await q1<any>(pool, "SELECT COUNT(*) n, COALESCE(SUM(total_paise),0) gmv, COALESCE(SUM(created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)),0) today FROM orders WHERE status NOT IN ('rejected','cancelled')"))!;
  const due = (await q1<any>(pool, 'SELECT COALESCE(SUM(GREATEST(balance_due_paise,0)),0) due FROM retailer_distributor_relations'))!;
  const exp = (await q1<any>(pool, 'SELECT COUNT(*) n FROM distributor_profiles WHERE subscription_ends_at BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY)'))!;
  const fails = (await q1<any>(pool, "SELECT COUNT(*) n FROM audit_log WHERE action IN ('auth.login_failed','auth.totp_failed') AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)"))!;
  const push = await q<any>(pool, "SELECT status, COUNT(*) n FROM push_outbox WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) GROUP BY status");
  res.json({
    push_24h: Object.fromEntries(push.map((p) => [p.status, Number(p.n)])),
    users: Object.fromEntries(users.map((u) => [u.role, { count: Number(u.n), inactive: Number(u.inactive) }])),
    orders: Number(o.n), orders_today: Number(o.today), gmv: fromPaise(Number(o.gmv)), receivables: fromPaise(Number(due.due)),
    subscriptions_expiring_7d: Number(exp.n), failed_logins_24h: Number(fails.n),
  });
}));

// The audit trail, newest first, filterable. `before` pages backwards.
adminRouter.get('/audit', asyncHandler(async (req, res) => {
  const qs = z.object({
    action: z.string().trim().max(60).optional(), entity: z.string().trim().max(40).optional(), actor_id: z.coerce.number().int().positive().optional(),
    before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  const where = ['1=1']; const args: unknown[] = [];
  if (qs.action) { where.push('a.action LIKE ?'); args.push(`${qs.action}%`); }
  if (qs.entity) { where.push('a.entity = ?'); args.push(qs.entity); }
  if (qs.actor_id) { where.push('a.actor_id = ?'); args.push(qs.actor_id); }
  if (qs.before) { where.push('a.id < ?'); args.push(qs.before); }
  const rows = await q<any>(pool, `SELECT a.id, a.actor_id, u.name actor_name, u.role actor_role, a.action, a.entity, a.entity_id, a.meta, a.created_at
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`, [...args, qs.limit + 1]);
  const page = rows.slice(0, qs.limit);
  res.json({ entries: page.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })), next_before: rows.length > qs.limit ? page[page.length - 1].id : null });
}));

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const qs = z.object({ q: z.string().trim().max(100).optional(), role: z.enum(['admin', 'distributor', 'employee', 'retailer']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  const where = ['1=1']; const args: unknown[] = [];
  if (qs.role) { where.push('u.role = ?'); args.push(qs.role); }
  if (qs.q) { where.push('(u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)'); const l = `%${qs.q}%`; args.push(l, l, l); }
  const rows = await q<any>(pool, `SELECT u.id, u.role, u.name, u.phone, u.email, u.is_active, u.email_verified_at, u.created_at, u.locked_until,
      COALESCE(rp.shop_name, dp.business_name) business FROM users u
    LEFT JOIN retailer_profiles rp ON rp.user_id = u.id LEFT JOIN distributor_profiles dp ON dp.user_id = u.id
    WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT ?`, [...args, qs.limit]);
  res.json({ users: rows.map((r) => ({ ...r, is_active: !!r.is_active, email_verified: !!r.email_verified_at, email_verified_at: undefined })) });
}));

// Suspend or restore an account. Suspending also signs the person out everywhere.
adminRouter.post('/users/:id/status', asyncHandler(async (req, res) => {
  const { is_active, reason } = z.object({ is_active: z.boolean(), reason: z.string().trim().max(200).optional() }).parse(req.body);
  const id = idParam(req);
  if (id === req.auth!.userId) throw new AppError(409, 'SELF', 'You cannot suspend your own account');
  const u = await q1<any>(pool, 'SELECT id, role FROM users WHERE id = ?', [id]);
  if (!u) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (u.role === 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin accounts are managed outside the console');
  await exec(pool, 'UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
  if (!is_active) await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]);
  invalidateUser(id);
  await audit(req.auth!.userId, is_active ? 'admin.user_restored' : 'admin.user_suspended', 'user', id, { reason });
  res.json({ id, is_active });
}));

// Money check across the whole platform: anything here needs a human.
adminRouter.get('/reconciliation', asyncHandler(async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
  res.json(await reconcile(null, days));
}));

// ---------------------------------------------------------------------------------------------
// Subscription plans, the payments distributors make for them, and where they pay
// ---------------------------------------------------------------------------------------------
const planBody = z.object({
  name: z.string().trim().min(2).max(60), days: z.number().int().min(1).max(3650), price: z.union([z.string(), z.number()]),
  description: z.string().trim().max(200).nullable().optional(), is_active: z.boolean().default(true), sort_order: z.number().int().min(0).max(1000).default(0),
});
const presentPlan = (p: any) => ({ id: p.id, name: p.name, days: p.days, price: fromPaise(Number(p.price_paise)), description: p.description, is_active: !!p.is_active, sort_order: p.sort_order });

adminRouter.get('/plans', asyncHandler(async (_req, res) => {
  res.json({ plans: (await q<any>(pool, 'SELECT * FROM subscription_plans ORDER BY sort_order, days')).map(presentPlan) });
}));
adminRouter.post('/plans', asyncHandler(async (req, res) => {
  const b = planBody.parse(req.body); const price = toPaise(b.price);
  if (price <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Price must be more than zero');
  const r = await exec(pool, 'INSERT INTO subscription_plans (name, days, price_paise, description, is_active, sort_order) VALUES (?,?,?,?,?,?)', [b.name, b.days, price, b.description ?? null, b.is_active ? 1 : 0, b.sort_order]);
  await audit(req.auth!.userId, 'plan.create', 'plan', r.insertId, { name: b.name, days: b.days, price_paise: price });
  res.status(201).json(presentPlan((await q1<any>(pool, 'SELECT * FROM subscription_plans WHERE id = ?', [r.insertId]))));
}));
// Changing a plan never changes what past payments bought: each payment keeps its own copy of name, days and price.
adminRouter.put('/plans/:id', asyncHandler(async (req, res) => {
  const b = planBody.partial().parse(req.body); const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM subscription_plans WHERE id = ?', [id]);
  if (!cur) throw new AppError(404, 'NOT_FOUND', 'Plan not found');
  const price = b.price === undefined ? Number(cur.price_paise) : toPaise(b.price);
  if (price <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Price must be more than zero');
  await exec(pool, 'UPDATE subscription_plans SET name=?, days=?, price_paise=?, description=?, is_active=?, sort_order=? WHERE id=?', [
    b.name ?? cur.name, b.days ?? cur.days, price, b.description === undefined ? cur.description : b.description, b.is_active === undefined ? cur.is_active : b.is_active ? 1 : 0, b.sort_order ?? cur.sort_order, id,
  ]);
  await audit(req.auth!.userId, 'plan.update', 'plan', id, b);
  res.json(presentPlan((await q1<any>(pool, 'SELECT * FROM subscription_plans WHERE id = ?', [id]))));
}));

adminRouter.get('/subscription-payments', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['pending', 'confirmed', 'rejected', 'failed', 'all']).default('pending') }).parse(req.query);
  const rows = await q<any>(pool, `SELECT sp.*, dp.business_name, u.phone, dp.subscription_ends_at FROM subscription_payments sp
    JOIN distributor_profiles dp ON dp.user_id = sp.distributor_id JOIN users u ON u.id = sp.distributor_id
    ${status === 'all' ? '' : 'WHERE sp.status = ?'} ORDER BY sp.id DESC LIMIT 100`, status === 'all' ? [] : [status]);
  res.json({ payments: rows.map((p) => ({ id: p.id, distributor_id: p.distributor_id, business_name: p.business_name, phone: p.phone, plan_name: p.plan_name, days: p.days, amount: fromPaise(Number(p.amount_paise)), method: p.method, utr: p.utr, status: p.status, created_at: p.created_at, decided_at: p.decided_at, current_ends_at: p.subscription_ends_at })) });
}));

adminRouter.post('/subscription-payments/:id/confirm', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const out = await withTx((c) => confirmSubscriptionPayment(c, id, req.auth!.userId));
  if (!out.replayed) await afterConfirm(id, out.payment.distributor_id, out.ends_at, out.payment.plan_name, req.auth!.userId);
  res.json({ replayed: out.replayed, status: 'confirmed', ends_at: out.ends_at });
}));

adminRouter.post('/subscription-payments/:id/reject', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body ?? {});
  const id = idParam(req);
  const p = await withTx(async (c) => {
    const row = await q1<any>(c, 'SELECT * FROM subscription_payments WHERE id = ? FOR UPDATE', [id]);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    if (row.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', `Payment already ${row.status}`);
    await exec(c, "UPDATE subscription_payments SET status = 'rejected', decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?", [req.auth!.userId, id]);
    return row;
  });
  await audit(req.auth!.userId, 'subscription.rejected', 'distributor', p.distributor_id, { payment_id: id, note });
  notifyUsers([p.distributor_id], 'Subscription payment not found', note ?? `We could not find your payment (UTR ${p.utr}). Check the reference number and submit it again.`, { type: 'subscription' });
  res.json({ status: 'rejected' });
}));

adminRouter.get('/settings', asyncHandler(async (_req, res) => { res.json(await companyPayment()); }));
adminRouter.put('/settings', asyncHandler(async (req, res) => {
  const b = z.object({
    company_upi_id: z.string().trim().regex(/^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/, 'UPI id looks like name@bank'),
    company_payee: z.string().trim().min(2).max(80).optional(),
  }).parse(req.body);
  for (const [name, value] of Object.entries({ company_upi_id: b.company_upi_id, ...(b.company_payee && { company_payee: b.company_payee }) }))
    await exec(pool, 'INSERT INTO platform_settings (name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, value]);
  await audit(req.auth!.userId, 'settings.company_payment', 'settings', null, { upi: b.company_upi_id });
  res.json(await companyPayment());
}));
