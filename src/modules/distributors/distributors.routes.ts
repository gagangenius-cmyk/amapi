import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, invalidateUser, requireRole, requireTwoFactor } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { notifyUsers } from '../../services/notify';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { assertPermission, assertSubscriptionActive, loadDistributor } from './subscription';

export const distributorRouter = Router();
distributorRouter.use(authenticate);

const publicProfile = (d: any) => ({
  id: d.user_id, business_name: d.business_name, gst_no: d.gst_no, address: d.address ?? null, city: d.city ?? null, pincode: d.pincode ?? null,
  bank_account_details: d.bank_account_details ? JSON.parse(d.bank_account_details) : null,
  permissions: d.permissions, commission_rate_bps: d.commission_rate_bps, subscription_ends_at: d.subscription_ends_at,
});

distributorRouter.get('/me', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const profile = publicProfile(await loadDistributor(pool, req.auth!.distributorId!));
  // delivery staff never see the owner's bank account; they only learn whether online payments are set up
  if (req.auth!.role === 'employee') return res.json({ ...profile, bank_account_details: null, upi_enabled: !!profile.bank_account_details?.upi_id });
  res.json({ ...profile, upi_enabled: !!profile.bank_account_details?.upi_id });
}));

// Payment details: a UPI id alone is enough; bank details are optional but must be complete and well-formed when given.
const bankSchema = z.object({
  upi_id: z.string().trim().regex(/^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/, 'UPI id looks like name@bank').optional(),
  account_name: z.string().trim().min(2).max(120).optional(),
  account_no: z.string().trim().regex(/^\d{9,18}$/, 'Account number is 9-18 digits').optional(),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234').optional(),
}).refine((b) => !!b.upi_id || (b.account_name && b.account_no && b.ifsc), { message: 'Give a UPI id, or the full bank details (name, account number, IFSC)' })
  .refine((b) => [b.account_name, b.account_no, b.ifsc].every(Boolean) || [b.account_name, b.account_no, b.ifsc].every((x) => !x), { message: 'Bank details need account name, number and IFSC together' });

distributorRouter.put('/me', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = z.object({
    business_name: z.string().min(2).max(190).optional(),
    gst_no: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters').optional(),
    bank_account_details: bankSchema.optional(),
    address: z.string().trim().min(3).max(255).optional(), city: z.string().trim().min(2).max(100).optional(), pincode: z.string().regex(/^\d{6}$/, 'Pincode is 6 digits').optional(),
  }).parse(req.body);
  const id = req.auth!.userId;
  await assertSubscriptionActive(pool, id);
  await exec(pool, `UPDATE distributor_profiles SET business_name = COALESCE(?, business_name), gst_no = COALESCE(?, gst_no), bank_account_details = COALESCE(?, bank_account_details),
    address = COALESCE(?, address), city = COALESCE(?, city), pincode = COALESCE(?, pincode) WHERE user_id = ?`, [
    b.business_name ?? null, b.gst_no ?? null, b.bank_account_details ? JSON.stringify(b.bank_account_details) : null, b.address ?? null, b.city ?? null, b.pincode ?? null, id,
  ]);
  if (b.bank_account_details) await audit(id, 'distributor.payment_details_changed', 'distributor', id, { upi: !!b.bank_account_details.upi_id });
  res.json(publicProfile(await loadDistributor(pool, id)));
}));

// Replace the set of pincodes this distributor serves.
distributorRouter.put('/pincodes', requireRole('distributor'), asyncHandler(async (req, res) => {
  const { pincodes } = z.object({ pincodes: z.array(z.string().regex(/^\d{6}$/)).max(500) }).parse(req.body);
  const id = req.auth!.userId;
  await assertSubscriptionActive(pool, id);
  const unique = [...new Set(pincodes)];
  await withTx(async (c) => {
    await exec(c, 'DELETE FROM service_pincodes WHERE distributor_id = ?', [id]);
    if (unique.length) await exec(c, 'INSERT INTO service_pincodes (distributor_id, pincode) VALUES ?', [unique.map((p) => [id, p])]);
  });
  res.json({ pincodes: unique });
}));

distributorRouter.get('/pincodes', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, 'SELECT pincode FROM service_pincodes WHERE distributor_id = ? ORDER BY pincode', [req.auth!.distributorId]);
  res.json({ pincodes: rows.map((r) => r.pincode) });
}));

distributorRouter.post('/employees', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = z.object({
    phone: z.string().regex(/^\d{10}$/), name: z.string().min(2).max(120), password: z.string().min(8).max(100),
    email: z.string().trim().toLowerCase().email().max(190).optional(),
  }).parse(req.body);
  const id = req.auth!.userId;
  await assertSubscriptionActive(pool, id);
  await assertPermission(pool, id, 'employees_enabled');
  if (await q1(pool, 'SELECT id FROM users WHERE phone = ?', [b.phone])) throw new AppError(409, 'PHONE_TAKEN', 'Phone already registered');
  if (b.email && (await q1(pool, 'SELECT id FROM users WHERE email = ?', [b.email]))) throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
  const r = await exec(pool, "INSERT INTO users (role, phone, email, name, password_hash, owner_distributor_id) VALUES ('employee',?,?,?,?,?)", [
    b.phone, b.email ?? null, b.name, await bcrypt.hash(b.password, 10), id,
  ]);
  await audit(id, 'employee.create', 'user', r.insertId, { phone: b.phone });
  res.status(201).json({ id: r.insertId, phone: b.phone, name: b.name });
}));

const OPEN = "('accepted','dispatched','out_for_delivery')";

// The team with their workload: how many deliveries each has open, and whether they can take more.
distributorRouter.get('/employees', requireRole('distributor'), asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `
    SELECT u.id, u.name, u.phone, u.is_active, u.is_available,
      (SELECT COUNT(*) FROM orders o WHERE o.assigned_employee_id = u.id AND o.status IN ${OPEN}) open_orders,
      (SELECT COUNT(*) FROM orders o WHERE o.assigned_employee_id = u.id AND o.status = 'delivered'
         AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'delivered' AND e.created_at >= UTC_DATE())) delivered_today
    FROM users u WHERE u.role = 'employee' AND u.owner_distributor_id = ? ORDER BY u.name`, [req.auth!.userId]);
  res.json({ employees: rows.map((r) => ({ ...r, is_active: !!r.is_active, is_available: !!r.is_available, open_orders: Number(r.open_orders), delivered_today: Number(r.delivered_today) })) });
}));

// Mark someone on leave / back, or switch their login off.
distributorRouter.put('/employees/:id', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = z.object({ is_available: z.boolean().optional(), is_active: z.boolean().optional(), name: z.string().trim().min(2).max(120).optional() })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const id = idParam(req);
  const e = await q1<any>(pool, "SELECT id FROM users WHERE id = ? AND role = 'employee' AND owner_distributor_id = ?", [id, req.auth!.userId]);
  if (!e) throw notFound('Team member');
  await exec(pool, 'UPDATE users SET is_available = COALESCE(?, is_available), is_active = COALESCE(?, is_active), name = COALESCE(?, name) WHERE id = ?', [
    b.is_available === undefined ? null : b.is_available ? 1 : 0, b.is_active === undefined ? null : b.is_active ? 1 : 0, b.name ?? null, id,
  ]);
  if (b.is_active === false) { await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]); invalidateUser(id); }
  await audit(req.auth!.userId, 'employee.update', 'user', id, b);
  res.json(await q1(pool, 'SELECT id, name, phone, is_active, is_available FROM users WHERE id = ?', [id]));
}));

// Delivery staff can mark themselves unavailable (and back) from their own phone.
distributorRouter.put('/me/availability', requireRole('employee'), asyncHandler(async (req, res) => {
  const { is_available } = z.object({ is_available: z.boolean() }).parse(req.body);
  await exec(pool, 'UPDATE users SET is_available = ? WHERE id = ?', [is_available ? 1 : 0, req.auth!.userId]);
  res.json({ is_available });
}));

// Hand over everything an unavailable person still has to deliver. Without `to_employee_id` the orders become unassigned.
distributorRouter.post('/employees/:id/reassign-all', requireRole('distributor'), asyncHandler(async (req, res) => {
  const { to_employee_id } = z.object({ to_employee_id: z.number().int().positive().nullable().optional() }).parse(req.body ?? {});
  const from = idParam(req); const d = req.auth!.userId;
  await assertPermission(pool, d, 'self_delivery');
  if (!(await q1(pool, "SELECT 1 FROM users WHERE id = ? AND role = 'employee' AND owner_distributor_id = ?", [from, d]))) throw notFound('Team member');
  if (to_employee_id) {
    const t = await q1<any>(pool, "SELECT is_available, is_active FROM users WHERE id = ? AND role = 'employee' AND owner_distributor_id = ?", [to_employee_id, d]);
    if (!t) throw notFound('Team member');
    if (!t.is_active || !t.is_available) throw new AppError(409, 'EMPLOYEE_UNAVAILABLE', 'That person is not available');
  }
  const r = await exec(pool, `UPDATE orders SET assigned_employee_id = ? WHERE assigned_employee_id = ? AND distributor_id = ? AND status IN ${OPEN}`, [to_employee_id ?? null, from, d]);
  await audit(d, 'order.reassign_all', 'user', from, { to: to_employee_id ?? null, orders: r.affectedRows });
  if (to_employee_id && r.affectedRows) notifyUsers([to_employee_id], 'Deliveries assigned', `${r.affectedRows} order${r.affectedRows === 1 ? '' : 's'} handed to you`, { type: 'order' });
  res.json({ moved: r.affectedRows });
}));

// Delivery board: every order that is on its way to being delivered, by who has it.
distributorRouter.get('/deliveries', requireRole('distributor'), asyncHandler(async (req, res) => {
  const d = req.auth!.userId;
  const emps = await q<any>(pool, "SELECT id, name, phone, is_available, is_active FROM users WHERE role = 'employee' AND owner_distributor_id = ? ORDER BY name", [d]);
  const orders = await q<any>(pool, `SELECT o.id, o.status, o.total_paise, o.created_at, o.assigned_employee_id, rp.shop_name, rp.pincode, rp.address,
      (SELECT MAX(created_at) FROM order_events e WHERE e.order_id = o.id) last_update
    FROM orders o JOIN retailer_profiles rp ON rp.user_id = o.retailer_id WHERE o.distributor_id = ? AND o.status IN ${OPEN} ORDER BY o.id`, [d]);
  const shape = (o: any) => ({ id: o.id, status: o.status, total: fromPaise(Number(o.total_paise)), shop_name: o.shop_name, pincode: o.pincode, address: o.address, created_at: o.created_at, last_update: o.last_update });
  res.json({
    unassigned: orders.filter((o) => !o.assigned_employee_id).map(shape),
    by_employee: emps.map((e) => ({ employee: { id: e.id, name: e.name, phone: e.phone, is_available: !!e.is_available, is_active: !!e.is_active }, orders: orders.filter((o) => o.assigned_employee_id === e.id).map(shape) })),
  });
}));

// Ask an existing retailer (by phone) to become a customer. Nothing is shared or posted until THEY accept.
// The answer is identical whether or not the number belongs to a retailer, so phone numbers cannot be probed.
distributorRouter.post('/retailers', requireRole('distributor'), asyncHandler(async (req, res) => {
  const { phone } = z.object({ phone: z.string().regex(/^\d{10}$/) }).parse(req.body);
  const id = req.auth!.userId;
  const dist = await assertSubscriptionActive(pool, id);
  const r = await q1<any>(pool, "SELECT id FROM users WHERE phone = ? AND role = 'retailer' AND is_active = 1", [phone]);
  if (r) {
    const created = await exec(pool, "INSERT IGNORE INTO retailer_distributor_relations (retailer_id, distributor_id, is_primary, status, requested_by) VALUES (?,?,0,'pending','distributor')", [r.id, id]);
    if (created.affectedRows) {
      await audit(id, 'relation.request', 'user', r.id);
      notifyUsers([r.id], 'New supplier request', `${dist.business_name} wants to supply you. Open AAYME to accept or decline.`, { type: 'link' });
    }
  }
  res.status(202).json({ status: 'request_sent', message: 'If a retailer with this number exists, they have been asked to approve.' });
}));

distributorRouter.get('/retailers', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `
    SELECT u.id, u.name, u.phone, rp.shop_name, rp.pincode, rdr.is_primary, rdr.balance_due_paise, rdr.credit_limit_paise, rdr.credit_days
    FROM retailer_distributor_relations rdr JOIN users u ON u.id = rdr.retailer_id
    JOIN retailer_profiles rp ON rp.user_id = u.id WHERE rdr.distributor_id = ? AND rdr.status = 'active' ORDER BY rp.shop_name`, [req.auth!.distributorId]);
  // Pending requests reveal only the phone number the distributor already typed.
  const pending = await q<any>(pool, `
    SELECT u.id, u.phone FROM retailer_distributor_relations rdr JOIN users u ON u.id = rdr.retailer_id
    WHERE rdr.distributor_id = ? AND rdr.status = 'pending' AND rdr.requested_by = 'distributor'`, [req.auth!.distributorId]);
  res.json({ retailers: rows, pending });
}));

distributorRouter.delete('/retailers/:retailerId', requireRole('distributor'), asyncHandler(async (req, res) => {
  const r = await exec(pool, "DELETE FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'pending'", [idParam(req, 'retailerId'), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Pending request');
  res.status(204).end();
}));

// Platform admin: feature flags and subscription extension.
distributorRouter.put('/:id/admin', requireRole('admin'), requireTwoFactor, asyncHandler(async (req, res) => {
  const b = z.object({
    permissions: z.record(z.string(), z.boolean()).optional(),
    extend_days: z.number().int().min(1).max(3650).optional(),
    commission_rate_bps: z.number().int().min(0).max(5000).optional(),
  }).parse(req.body);
  const id = idParam(req);
  const d = await loadDistributor(pool, id);
  const perms = { ...d.permissions, ...(b.permissions ?? {}) };
  await exec(pool, `UPDATE distributor_profiles SET permissions = ?, commission_rate_bps = COALESCE(?, commission_rate_bps),
    subscription_ends_at = IF(? IS NULL, subscription_ends_at, DATE_ADD(GREATEST(subscription_ends_at, UTC_TIMESTAMP()), INTERVAL ? DAY)),
    expiry_warned_at = IF(? IS NULL, expiry_warned_at, NULL) WHERE user_id = ?`, [
    JSON.stringify(perms), b.commission_rate_bps ?? null, b.extend_days ?? null, b.extend_days ?? 0, b.extend_days ?? null, id,
  ]);
  await exec(pool, "INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?, 'distributor.admin_update', 'distributor', ?, ?)", [
    req.auth!.userId, id, JSON.stringify(b),
  ]);
  res.json(publicProfile(await loadDistributor(pool, id)));
}));
