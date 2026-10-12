import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1 } from '../../db/pool';
import { authenticate, invalidateUser, requireRole, requireTwoFactor } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { reconcile } from '../collections/collections.routes';
import { PERMISSION_CATALOG } from '../distributors/subscription';
import { afterConfirm, companyPayment, confirmSubscriptionPayment } from '../subscription/subscription.service';
import { notifyUsers } from '../../services/notify';
import { toPaise } from '../../utils/money';
import { withTx } from '../../db/pool';
import bcrypt from 'bcryptjs';
import { adminReportsRouter } from '../reports/admin.reports.routes';
import { adminCatalogRouter } from '../catalog/admin.catalog.routes';
import { adminCommissionRouter } from '../commission/commission.routes';
import { cleanActions, cleanGrantable, effectivePermissions, parseStaffPermissions, STAFF_ACTIONS } from '../staff/permissions';
import { assertIdentityFree, commissionReport, createDistributorAccount, distributorBody, dupToConflict, listDistributors } from '../staff/staff.service';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'), requireTwoFactor);
adminRouter.use(adminReportsRouter);
adminRouter.use(adminCatalogRouter);
adminRouter.use(adminCommissionRouter);

adminRouter.get('/distributors', asyncHandler(async (_req, res) => {
  res.json({ permission_catalog: PERMISSION_CATALOG, distributors: await listDistributors('1=1', []) });
}));

// The admin opens a distributor account directly (all switches on unless told otherwise, subscription length is theirs to choose).
adminRouter.post('/distributors', asyncHandler(async (req, res) => {
  const b = distributorBody.parse(req.body);
  const out = await createDistributorAccount(b, req.auth!.userId, null);
  await audit(req.auth!.userId, 'admin.distributor_create', 'user', out.id, { phone: b.phone });
  res.status(201).json({ id: out.id, phone: b.phone, business_name: b.business_name, permissions: out.permissions });
}));

// Orders placed with non-pinned distributors, for commission tracking.
adminRouter.get('/commissions', asyncHandler(async (_req, res) => {
  res.json({ commissions: await commissionReport() });
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
  const qs = z.object({ q: z.string().trim().max(100).optional(), role: z.enum(['admin', 'distributor', 'employee', 'retailer', 'company_employee']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
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

// ---------------------------------------------------------------------------------------------
// Company employees: the admin creates them and decides what each may do and which
// distributor feature switches they may hand out.
// ---------------------------------------------------------------------------------------------
const presentStaff = (r: any) => {
  const p = effectivePermissions(r);
  return {
    id: r.id, name: r.name, phone: r.phone, email: r.email, is_active: !!r.is_active, actions: p.actions, grantable: p.grantable,
    role_id: r.role_id ?? null, role_name: r.role_name ?? null, created_at: r.created_at, distributors_created: Number(r.distributors_created ?? 0),
  };
};
const STAFF_SELECT = `SELECT u.id, u.name, u.phone, u.email, u.is_active, u.staff_permissions, u.role_id, u.created_at,
  ro.name role_name, ro.actions role_actions, ro.grantable role_grantable,
  (SELECT COUNT(*) FROM users d WHERE d.created_by = u.id AND d.role = 'distributor') distributors_created
  FROM users u LEFT JOIN roles ro ON ro.id = u.role_id`;

// ---- named roles ----
const presentRole = (r: any) => ({
  id: r.id, name: r.name, description: r.description, is_system: !!r.is_system,
  actions: cleanActions(JSON.parse(r.actions)),
  grantable: cleanGrantable(JSON.parse(r.grantable)),
  members: Number(r.members ?? 0),
});
const ROLE_SELECT = 'SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) members FROM roles r';
const roleBody = z.object({
  name: z.string().trim().min(2).max(60), description: z.string().trim().max(200).nullable().optional(),
  actions: z.array(z.string()).max(50), grantable: z.array(z.string()).max(50),
});

adminRouter.get('/roles', asyncHandler(async (_req, res) => {
  res.json({ action_catalog: STAFF_ACTIONS, grant_catalog: PERMISSION_CATALOG, roles: (await q<any>(pool, `${ROLE_SELECT} ORDER BY r.is_system DESC, r.name`)).map(presentRole) });
}));

adminRouter.post('/roles', asyncHandler(async (req, res) => {
  const b = roleBody.parse(req.body);
  let id: number;
  try {
    const r = await exec(pool, 'INSERT INTO roles (name, description, actions, grantable, created_by) VALUES (?,?,?,?,?)', [
      b.name, b.description ?? null, JSON.stringify(cleanActions(b.actions)), JSON.stringify(cleanGrantable(b.grantable)), req.auth!.userId,
    ]);
    id = r.insertId;
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'ROLE_EXISTS', 'A role with this name already exists');
    throw e;
  }
  await audit(req.auth!.userId, 'admin.role_create', 'role', id, { name: b.name });
  res.status(201).json(presentRole((await q1<any>(pool, `${ROLE_SELECT} WHERE r.id = ?`, [id]))));
}));

adminRouter.put('/roles/:id', asyncHandler(async (req, res) => {
  const b = roleBody.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM roles WHERE id = ?', [id]);
  if (!cur) throw new AppError(404, 'NOT_FOUND', 'Role not found');
  if (cur.is_system) throw new AppError(409, 'SYSTEM_ROLE', 'Built-in roles cannot be changed. Create a copy with the powers you want.');
  try {
    await exec(pool, 'UPDATE roles SET name = ?, description = ?, actions = ?, grantable = ? WHERE id = ?', [
      b.name ?? cur.name, b.description === undefined ? cur.description : b.description,
      b.actions ? JSON.stringify(cleanActions(b.actions)) : cur.actions, b.grantable ? JSON.stringify(cleanGrantable(b.grantable)) : cur.grantable, id,
    ]);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'ROLE_EXISTS', 'A role with this name already exists');
    throw e;
  }
  await audit(req.auth!.userId, 'admin.role_update', 'role', id, b);
  res.json(presentRole((await q1<any>(pool, `${ROLE_SELECT} WHERE r.id = ?`, [id]))));
}));

adminRouter.delete('/roles/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const cur = await q1<any>(pool, `${ROLE_SELECT} WHERE r.id = ?`, [id]);
  if (!cur) throw new AppError(404, 'NOT_FOUND', 'Role not found');
  if (cur.is_system) throw new AppError(409, 'SYSTEM_ROLE', 'Built-in roles cannot be deleted');
  if (Number(cur.members) > 0) throw new AppError(409, 'ROLE_IN_USE', `${cur.members} employee${Number(cur.members) === 1 ? ' holds' : 's hold'} this role. Move them to another role first.`);
  await exec(pool, 'DELETE FROM roles WHERE id = ?', [id]);
  await audit(req.auth!.userId, 'admin.role_delete', 'role', id, { name: cur.name });
  res.status(204).end();
}));

adminRouter.get('/staff', asyncHandler(async (_req, res) => {
  const rows = await q<any>(pool, `${STAFF_SELECT} WHERE u.role = 'company_employee' ORDER BY u.id DESC`);
  res.json({ action_catalog: STAFF_ACTIONS, grant_catalog: PERMISSION_CATALOG, staff: rows.map(presentStaff) });
}));

adminRouter.post('/staff', asyncHandler(async (req, res) => {
  const b = z.object({
    phone: z.string().regex(/^\d{10}$/, '10-digit phone'), name: z.string().trim().min(2).max(120), password: z.string().min(8).max(100),
    email: z.string().trim().toLowerCase().email().max(190).optional(),
    actions: z.array(z.string()).max(50).default([]), grantable: z.array(z.string()).max(50).default([]),
    role_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body);
  const perms = { actions: cleanActions(b.actions), grantable: cleanGrantable(b.grantable) };
  if (b.role_id && !(await q1(pool, 'SELECT id FROM roles WHERE id = ?', [b.role_id]))) throw new AppError(400, 'BAD_ROLE', 'Unknown role');
  const hash = await bcrypt.hash(b.password, 10);
  let id: number;
  try {
    id = await withTx(async (c) => {
      await assertIdentityFree(c, b.phone, b.email);
      const r = await exec(c, "INSERT INTO users (role, phone, email, name, password_hash, created_by, staff_permissions, role_id) VALUES ('company_employee',?,?,?,?,?,?,?)", [
        b.phone, b.email ?? null, b.name, hash, req.auth!.userId, JSON.stringify(perms), b.role_id ?? null,
      ]);
      return r.insertId as number;
    });
  } catch (e) { return dupToConflict(e); }
  await audit(req.auth!.userId, 'admin.staff_create', 'user', id, { phone: b.phone, role_id: b.role_id ?? null, ...perms });
  res.status(201).json(presentStaff((await q1<any>(pool, `${STAFF_SELECT} WHERE u.id = ?`, [id]))));
}));

adminRouter.put('/staff/:id', asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(120).optional(), is_active: z.boolean().optional(),
    actions: z.array(z.string()).max(50).optional(), grantable: z.array(z.string()).max(50).optional(),
    role_id: z.number().int().positive().nullable().optional(),
    password: z.string().min(8).max(100).optional(),
  }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const id = idParam(req);
  const cur = await q1<any>(pool, `${STAFF_SELECT} WHERE u.id = ? AND u.role = 'company_employee'`, [id]);
  if (!cur) throw new AppError(404, 'NOT_FOUND', 'Company employee not found');
  if (b.role_id && !(await q1(pool, 'SELECT id FROM roles WHERE id = ?', [b.role_id]))) throw new AppError(400, 'BAD_ROLE', 'Unknown role');

  // Choosing a role hands the powers to that role. Editing the powers directly makes them "custom" (no role).
  const own = effectivePermissions({ staff_permissions: cur.staff_permissions });
  const was = effectivePermissions(cur);
  let roleId: number | null = cur.role_id ?? null;
  let perms = own;
  if (b.role_id !== undefined) roleId = b.role_id;
  else if (b.actions || b.grantable) { roleId = null; perms = was; }
  if (b.actions || b.grantable) perms = { actions: b.actions ? cleanActions(b.actions) : perms.actions, grantable: b.grantable ? cleanGrantable(b.grantable) : perms.grantable };

  await exec(pool, 'UPDATE users SET name = COALESCE(?, name), is_active = COALESCE(?, is_active), staff_permissions = ?, role_id = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?', [
    b.name ?? null, b.is_active === undefined ? null : b.is_active ? 1 : 0, JSON.stringify(perms), roleId, b.password ? await bcrypt.hash(b.password, 10) : null, id,
  ]);
  // a switched-off person, or a new password, ends their sessions at once
  if (b.is_active === false || b.password) await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]);
  invalidateUser(id);
  await audit(req.auth!.userId, 'admin.staff_update', 'user', id, { ...b, password: b.password ? '(changed)' : undefined });
  res.json(presentStaff((await q1<any>(pool, `${STAFF_SELECT} WHERE u.id = ?`, [id]))));
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
