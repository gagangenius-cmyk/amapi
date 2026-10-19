import { env } from '../../config/env';
import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, idempotencyKey, requireRole } from '../../middleware/auth';
import { getGateway } from '../../services/gateway';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler } from '../../utils/errors';
import { fromPaise } from '../../utils/money';
import { loadDistributor } from '../distributors/subscription';
import { companyPayment, upiUri } from './subscription.service';

/**
 * A distributor choosing and paying for a plan. Open even when the subscription has expired (that is exactly when it is needed).
 * UPI payments wait for the platform admin to confirm; payments through the gateway confirm themselves via its signed webhook.
 */
export const subscriptionRouter = Router();
subscriptionRouter.use(authenticate, requireRole('distributor'));

export const WARN_DAYS = 5;

const presentPayment = (p: any) => ({
  id: p.id, plan_name: p.plan_name, days: p.days, amount: fromPaise(Number(p.amount_paise)), method: p.method, utr: p.utr, status: p.status,
  checkout_url: p.status === 'pending' ? p.checkout_url ?? null : null, created_at: p.created_at, extended_to: p.extended_to,
});

export async function subscriptionState(distributorId: number, now = new Date()) {
  const d = await loadDistributor(pool, distributorId);
  if (env.freeOnboarding) { // testing period: free and always active
    const far = new Date(+now + 3650 * 86_400_000);
    return { plan_name: 'Free (testing)', ends_at: far, now, seconds_left: 3650 * 86400, days_left: 3650, status: 'active' as const, warn_days: WARN_DAYS, free_mode: true };
  }
  const ends = new Date(d.subscription_ends_at);
  const seconds = Math.floor((+ends - +now) / 1000);
  const days = Math.ceil(seconds / 86400);
  const status = seconds <= 0 ? 'expired' : days <= WARN_DAYS ? 'expiring' : 'active';
  return { plan_name: d.plan_name ?? (seconds > 0 ? 'Trial' : null), ends_at: ends, now, seconds_left: Math.max(0, seconds), days_left: Math.max(0, days), status, warn_days: WARN_DAYS, free_mode: false };
}

subscriptionRouter.get('/', asyncHandler(async (req, res) => {
  const d = req.auth!.userId;
  const [state, plans, company, pending, history] = await Promise.all([
    subscriptionState(d),
    q<any>(pool, 'SELECT id, name, days, price_paise, description FROM subscription_plans WHERE is_active = 1 AND price_paise > 0 ORDER BY sort_order, days'),
    companyPayment(),
    q1<any>(pool, "SELECT * FROM subscription_payments WHERE distributor_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [d]),
    q<any>(pool, 'SELECT * FROM subscription_payments WHERE distributor_id = ? ORDER BY id DESC LIMIT 10', [d]),
  ]);
  res.json({
    ...state,
    plans: env.freeOnboarding ? [] : plans.map((p) => ({ id: p.id, name: p.name, days: p.days, price: fromPaise(Number(p.price_paise)), description: p.description })),
    pay_by_upi: company.upi_id ? { upi_id: company.upi_id, payee: company.payee } : null,
    pay_by_gateway: !!getGateway(),
    pending: pending ? presentPayment(pending) : null,
    history: history.map(presentPayment),
  });
}));

subscriptionRouter.post('/checkout', asyncHandler(async (req, res) => {
  const b = z.object({
    plan_id: z.number().int().positive(), method: z.enum(['upi', 'gateway']),
    utr: z.string().regex(/^[A-Za-z0-9]{8,30}$/, 'UTR must be 8-30 letters/digits').optional(),
  }).parse(req.body);
  const d = req.auth!.userId; const key = idempotencyKey(req);

  const dup = await q1<any>(pool, 'SELECT * FROM subscription_payments WHERE distributor_id = ? AND idempotency_key = ?', [d, key]);
  if (dup) return void res.status(200).json({ replayed: true, payment: presentPayment(dup), checkout_url: dup.checkout_url });

  const plan = await q1<any>(pool, 'SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1 AND price_paise > 0', [b.plan_id]);
  if (!plan) throw new AppError(404, 'NOT_FOUND', 'That plan is not available');

  if (b.method === 'upi') {
    const company = await companyPayment();
    if (!company.upi_id) throw new AppError(501, 'NO_COMPANY_UPI', 'Subscription payments are not set up yet. Please contact support.');
    if (!b.utr) throw new AppError(400, 'UTR_REQUIRED', 'Enter the UTR (reference number) of your UPI payment');
    if (await q1(pool, "SELECT 1 FROM subscription_payments WHERE distributor_id = ? AND method = 'upi' AND status = 'pending'", [d]))
      throw new AppError(409, 'PENDING_EXISTS', 'You already have a payment waiting for confirmation. It is usually confirmed within a few hours.');
    try {
      const r = await exec(pool, "INSERT INTO subscription_payments (distributor_id, plan_id, plan_name, days, amount_paise, method, utr, idempotency_key) VALUES (?,?,?,?,?,'upi',?,?)",
        [d, plan.id, plan.name, plan.days, plan.price_paise, b.utr.toUpperCase(), key]);
      const row = await q1<any>(pool, 'SELECT * FROM subscription_payments WHERE id = ?', [r.insertId]);
      const admins = (await q<any>(pool, "SELECT id FROM users WHERE role = 'admin' AND is_active = 1")).map((a) => a.id);
      notifyUsers(admins, 'Subscription payment to confirm', `${plan.name} · ₹${fromPaise(Number(plan.price_paise))} · UTR ${b.utr.toUpperCase()}`, { type: 'subscription_payment', id: r.insertId });
      await audit(d, 'subscription.payment_reported', 'distributor', d, { payment_id: r.insertId, plan: plan.name });
      return void res.status(201).json({ replayed: false, payment: presentPayment(row), checkout_url: null });
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'UTR_USED', 'That UTR was already submitted');
      throw e;
    }
  }

  const gw = getGateway();
  if (!gw) throw new AppError(501, 'GATEWAY_NOT_CONFIGURED', 'Card payments are not available. Pay by UPI instead.');
  const ins = await exec(pool, "INSERT INTO subscription_payments (distributor_id, plan_id, plan_name, days, amount_paise, method, idempotency_key) VALUES (?,?,?,?,?,'gateway',?)", [d, plan.id, plan.name, plan.days, plan.price_paise, key]);
  const me = (await q1<any>(pool, 'SELECT name, phone, email FROM users WHERE id = ?', [d]))!;
  try {
    const link = await gw.createPaymentLink({ amountPaise: Number(plan.price_paise), referenceId: `sp_${ins.insertId}`, description: `AAYME ${plan.name} subscription`, customer: { name: me.name, phone: me.phone, email: me.email } });
    await exec(pool, 'UPDATE subscription_payments SET gateway_ref = ?, checkout_url = ? WHERE id = ?', [link.id, link.url, ins.insertId]);
    const row = await q1<any>(pool, 'SELECT * FROM subscription_payments WHERE id = ?', [ins.insertId]);
    res.status(201).json({ replayed: false, payment: presentPayment(row), checkout_url: link.url });
  } catch (err: any) {
    await exec(pool, "UPDATE subscription_payments SET status = 'failed' WHERE id = ?", [ins.insertId]);
    throw new AppError(502, 'GATEWAY_ERROR', 'The payment service did not respond. Nothing was charged. Please try again.', { reason: String(err?.message ?? err).slice(0, 120) });
  }
}));
