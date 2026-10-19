import bcrypt from 'bcryptjs';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { env } from '../../config/env';
import { idempotencyKey, requireRole } from '../../middleware/auth';
import { getGateway } from '../../services/gateway';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { validateCategoryChoice } from '../catalog/scope';
import { loadStaffPermissions, requireStaffAction } from '../staff/permissions';
import { assertIdentityFree, dupToConflict, grantCatalog, resolvePermissions } from '../staff/staff.service';
import { companyPayment } from '../subscription/subscription.service';
import { afterOnboarding, completeOnboarding, OPEN, presentOnboarding } from './onboarding.service';

const gst = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters');
const body = z.object({
  business_name: z.string().trim().min(2).max(190), name: z.string().trim().min(2).max(120),
  phone: z.string().regex(/^\d{10}$/, '10-digit phone'), password: z.string().min(8).max(100),
  email: z.string().trim().toLowerCase().email().max(190).optional(), gst_no: gst.optional(),
  address: z.string().trim().min(3).max(255).optional(), city: z.string().trim().min(2).max(100).optional(), pincode: z.string().regex(/^\d{6}$/, 'Pincode is 6 digits').optional(),
  plan_id: z.number().int().positive(), method: z.enum(['upi', 'gateway']),
  category_ids: z.array(z.number().int().positive()).min(1, 'Choose at least one category the distributor deals in').max(30),
  permissions: z.record(z.string(), z.boolean()).optional(),
  review_required: z.boolean().optional(),
});

const SELECT = `SELECT o.*, u.name created_by_name FROM onboarding_requests o JOIN users u ON u.id = o.created_by`;

// =============================================================================================
// Company employee
// =============================================================================================
export const staffOnboardingRouter = Router();

staffOnboardingRouter.get('/meta', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  const p = await loadStaffPermissions(req.auth!.userId);
  const [plans, categories, company] = await Promise.all([
    q<any>(pool, 'SELECT id, name, days, price_paise, description FROM subscription_plans WHERE is_active = 1 ORDER BY sort_order, days'),
    q<any>(pool, "SELECT id, name, parent_id FROM categories WHERE status <> 'retired' ORDER BY name"),
    companyPayment(),
  ]);
  res.json({
    plans: plans.map((x) => ({ id: x.id, name: x.name, days: x.days, price: env.freeOnboarding ? '0.00' : fromPaise(Number(x.price_paise)), description: x.description })),
    categories, grant_catalog: grantCatalog(p.grantable),
    free_mode: env.freeOnboarding,
    pay_by_upi: !!company.upi_id, pay_by_gateway: !!getGateway(),
    reviews_products: p.actions.includes('review_products'),
  });
}));

staffOnboardingRouter.post('/', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  const b = body.parse(req.body);
  const me = req.auth!.userId; const key = idempotencyKey(req);

  const dup = await q1<any>(pool, `${SELECT} WHERE o.created_by = ? AND o.idempotency_key = ?`, [me, key]);
  if (dup) return void res.json({ replayed: true, request: presentOnboarding(dup, await companyPayment()), checkout_url: dup.checkout_url });

  const perms = await loadStaffPermissions(me);
  const plan = await q1<any>(pool, 'SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1', [b.plan_id]);
  if (!plan) throw new AppError(404, 'NOT_FOUND', 'That plan is not available');
  const permissions = resolvePermissions(b.permissions, perms.grantable, null);
  const categories = await validateCategoryChoice(pool, b.category_ids);
  const company = await companyPayment();
  const free = env.freeOnboarding; // testing period: no fee, no payment step
  if (!free && b.method === 'upi' && !company.upi_id) throw new AppError(501, 'NO_COMPANY_UPI', 'The company UPI id is not set up yet. Ask the admin to add it.');
  const gw = !free && b.method === 'gateway' ? getGateway() : null;
  if (!free && b.method === 'gateway' && !gw) throw new AppError(501, 'GATEWAY_NOT_CONFIGURED', 'Online payment links are not available. Use UPI.');

  await assertIdentityFree(pool, b.phone, b.email);
  const open = await q1(pool, "SELECT id FROM onboarding_requests WHERE phone = ? AND status IN ('awaiting_payment','payment_submitted')", [b.phone]);
  if (open) throw new AppError(409, 'ONBOARDING_EXISTS', `An onboarding for this phone is already waiting for payment (#${(open as any).id})`);
  // only someone who may review products can have a distributor's products held for review
  const review = perms.actions.includes('review_products') ? b.review_required ?? true : false;

  let id: number;
  try {
    const r = await exec(pool, `INSERT INTO onboarding_requests (created_by, phone, email, owner_name, password_hash, business_name, gst_no, address, city, pincode, permissions, category_ids, review_required,
      plan_id, plan_name, days, amount_paise, method, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [me, b.phone, b.email ?? null, b.name, await bcrypt.hash(b.password, 10), b.business_name, b.gst_no ?? null, b.address ?? null, b.city ?? null, b.pincode ?? null,
        JSON.stringify(permissions), JSON.stringify(categories), review ? 1 : 0, plan.id, plan.name, plan.days, free ? 0 : plan.price_paise, free ? 'upi' : b.method, key]);
    id = r.insertId;
  } catch (e) { return dupToConflict(e); }

  if (gw) {
    try {
      const link = await gw.createPaymentLink({ amountPaise: Number(plan.price_paise), referenceId: `ob_${id}`, description: `AAYME ${plan.name} subscription for ${b.business_name}`, customer: { name: b.name, phone: b.phone, email: b.email } });
      await exec(pool, 'UPDATE onboarding_requests SET gateway_ref = ?, checkout_url = ? WHERE id = ?', [link.id, link.url, id]);
    } catch (err: any) {
      await exec(pool, "UPDATE onboarding_requests SET status = 'failed', error = 'The payment service did not respond' WHERE id = ?", [id]);
      throw new AppError(502, 'GATEWAY_ERROR', 'The payment service did not respond. Nothing was charged. Please try again.', { reason: String(err?.message ?? err).slice(0, 120) });
    }
  }
  await audit(me, 'onboarding.requested', 'onboarding', id, { business_name: b.business_name, plan: plan.name, method: free ? 'free' : b.method, amount_paise: free ? 0 : Number(plan.price_paise) });
  if (free) {
    // no fee to wait for: create the distributor now (same path as a confirmed payment, so the plan days, categories and trail are identical)
    const done = await withTx((c) => completeOnboarding(c, id, { decidedBy: me }));
    await afterOnboarding(done, me);
    if (!done.ok) throw new AppError(409, 'ONBOARDING_FAILED', done.reason ?? 'The account could not be created');
  }
  const row = (await q1<any>(pool, `${SELECT} WHERE o.id = ?`, [id]))!;
  res.status(201).json({ replayed: false, request: presentOnboarding(row, company), checkout_url: row.checkout_url });
}));

staffOnboardingRouter.get('/', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'completed', 'failed', 'cancelled', 'all']).default('all') }).parse(req.query);
  const where = status === 'open' ? "AND o.status IN ('awaiting_payment','payment_submitted')" : status === 'all' ? '' : 'AND o.status = ?';
  const rows = await q<any>(pool, `${SELECT} WHERE o.created_by = ? ${where} ORDER BY o.id DESC LIMIT 100`, status === 'open' || status === 'all' ? [req.auth!.userId] : [req.auth!.userId, status]);
  const company = await companyPayment();
  res.json({ requests: rows.map((r) => presentOnboarding(r, company)) });
}));

const ownRequest = async (req: Request) => {
  const r = await q1<any>(pool, `${SELECT} WHERE o.id = ? AND o.created_by = ?`, [idParam(req), req.auth!.userId]);
  if (!r) throw notFound('Onboarding request');
  return r;
};

staffOnboardingRouter.get('/:id', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  res.json({ request: presentOnboarding(await ownRequest(req), await companyPayment()) });
}));

// The distributor paid the company by UPI: record the reference. The admin confirms it against the bank, and that creates the account.
staffOnboardingRouter.post('/:id/utr', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  const { utr } = z.object({ utr: z.string().regex(/^[A-Za-z0-9]{8,30}$/, 'UTR must be 8-30 letters/digits') }).parse(req.body);
  const r = await ownRequest(req);
  if (r.method !== 'upi') throw new AppError(409, 'NOT_UPI', 'This request is paid through an online payment link, not UPI');
  if (r.status !== 'awaiting_payment') throw new AppError(409, 'BAD_STATE', `This request is ${r.status.replace('_', ' ')}`);
  const used = await q1(pool, 'SELECT 1 FROM subscription_payments WHERE utr = ?', [utr.toUpperCase()]);
  if (used) throw new AppError(409, 'UTR_USED', 'That UTR was already submitted');
  try {
    await exec(pool, "UPDATE onboarding_requests SET utr = ?, status = 'payment_submitted' WHERE id = ? AND status = 'awaiting_payment'", [utr.toUpperCase(), r.id]);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'UTR_USED', 'That UTR was already submitted');
    throw e;
  }
  const admins = (await q<any>(pool, "SELECT id FROM users WHERE role = 'admin' AND is_active = 1")).map((a) => a.id);
  notifyUsers(admins, 'Onboarding payment to confirm', `${r.business_name} · ₹${fromPaise(Number(r.amount_paise))} · UTR ${utr.toUpperCase()}`, { type: 'onboarding', id: r.id });
  await audit(req.auth!.userId, 'onboarding.payment_reported', 'onboarding', r.id, { utr: utr.toUpperCase() });
  res.json({ request: presentOnboarding((await ownRequest(req)), await companyPayment()) });
}));

staffOnboardingRouter.post('/:id/cancel', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  const r = await ownRequest(req);
  if (r.method !== 'upi' || r.status !== 'awaiting_payment') throw new AppError(409, 'CANNOT_CANCEL', 'Only a UPI request that has not been paid can be cancelled. A payment link cannot be withdrawn.');
  const u = await exec(pool, "UPDATE onboarding_requests SET status = 'cancelled', decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'awaiting_payment'", [req.auth!.userId, r.id]);
  if (!u.affectedRows) throw new AppError(409, 'BAD_STATE', 'This request has just changed');
  await audit(req.auth!.userId, 'onboarding.cancelled', 'onboarding', r.id);
  res.json({ id: r.id, status: 'cancelled' });
}));

// =============================================================================================
// Admin: confirm the UPI money actually arrived
// =============================================================================================
export const adminOnboardingRouter = Router();
adminOnboardingRouter.use(requireRole('admin'));

adminOnboardingRouter.get('/onboarding', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'payment_submitted', 'awaiting_payment', 'completed', 'failed', 'cancelled', 'all']).default('payment_submitted') }).parse(req.query);
  const where = status === 'all' ? '' : status === 'open' ? "WHERE o.status IN ('awaiting_payment','payment_submitted')" : 'WHERE o.status = ?';
  const rows = await q<any>(pool, `${SELECT} ${where} ORDER BY o.id DESC LIMIT 100`, status === 'all' || status === 'open' ? [] : [status]);
  res.json({ requests: rows.map((r) => presentOnboarding(r)) });
}));

adminOnboardingRouter.post('/onboarding/:id/confirm', asyncHandler(async (req: Request, res: Response) => {
  const id = idParam(req);
  const row = await q1<any>(pool, 'SELECT method, status FROM onboarding_requests WHERE id = ?', [id]);
  if (!row) throw notFound('Onboarding request');
  // a gateway payment is confirmed only by the gateway's signed callback, never by a person
  if (row.method !== 'upi') throw new AppError(409, 'GATEWAY_REQUEST', 'This one is paid through a payment link and confirms itself when the money arrives');
  if (row.status !== 'payment_submitted' && row.status !== 'completed') throw new AppError(409, 'NOT_SUBMITTED', 'The UPI reference has not been entered yet');
  const done = await withTx((c) => completeOnboarding(c, id, { decidedBy: req.auth!.userId }));
  await afterOnboarding(done, req.auth!.userId);
  if (!done.ok) throw new AppError(409, 'NEEDS_ATTENTION', done.reason ?? 'The account could not be created');
  res.json({ id, status: 'completed', distributor_id: done.distributorId, ends_at: done.endsAt, replayed: done.replayed });
}));

adminOnboardingRouter.post('/onboarding/:id/reject', asyncHandler(async (req: Request, res: Response) => {
  const { note } = z.object({ note: z.string().trim().min(3).max(200) }).parse(req.body);
  const id = idParam(req);
  const r = await q1<any>(pool, 'SELECT * FROM onboarding_requests WHERE id = ?', [id]);
  if (!r) throw notFound('Onboarding request');
  const u = await exec(pool, "UPDATE onboarding_requests SET status = 'failed', error = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'payment_submitted' AND method = 'upi'", [note, req.auth!.userId, id]);
  if (!u.affectedRows) throw new AppError(409, 'BAD_STATE', 'Only a UPI payment waiting for confirmation can be rejected');
  notifyUsers([r.created_by], 'Onboarding payment not found', `${r.business_name}: ${note}`, { type: 'onboarding', id });
  await audit(req.auth!.userId, 'onboarding.rejected', 'onboarding', id, { note });
  res.json({ id, status: 'failed' });
}));
