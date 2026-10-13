import { Conn, exec, q1 } from '../../db/pool';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { fromPaise } from '../../utils/money';
import { assertIdentityFree } from '../staff/staff.service';
import { upiUri } from '../subscription/subscription.service';

/**
 * PAID ONBOARDING
 * A company employee starts onboarding a distributor. Nothing exists yet except an onboarding request that holds the details.
 * When the subscription fee is RECEIVED (the gateway confirms the exact amount, or the admin confirms the UPI payment), and
 * only then, the distributor account is created, with its subscription timer starting at that moment for the plan's days.
 *
 *   awaiting_payment -> payment_submitted (UPI: the UTR was entered) -> completed
 *   awaiting_payment -> failed (gateway: expired, or the amount paid was wrong)   payment_submitted -> failed (admin: not found)
 *   awaiting_payment -> cancelled (UPI only: a gateway link cannot be withdrawn, so those are never cancelled)
 */
export type OnboardingStatus = 'awaiting_payment' | 'payment_submitted' | 'completed' | 'cancelled' | 'failed';
export const OPEN: OnboardingStatus[] = ['awaiting_payment', 'payment_submitted'];

export const presentOnboarding = (r: any, company?: { upi_id: string | null; payee: string }) => ({
  id: r.id, status: r.status as OnboardingStatus, business_name: r.business_name, owner_name: r.owner_name, phone: r.phone, email: r.email,
  plan_name: r.plan_name, days: r.days, amount: fromPaise(Number(r.amount_paise)), method: r.method as 'upi' | 'gateway', utr: r.utr,
  checkout_url: r.status === 'awaiting_payment' ? r.checkout_url ?? null : null,
  pay_to: r.method === 'upi' && r.status === 'awaiting_payment' && company?.upi_id
    ? { upi_id: company.upi_id, payee: company.payee, uri: upiUri(company.upi_id, company.payee, Number(r.amount_paise), `AAYME onboarding ${r.id}`) } : null,
  distributor_id: r.distributor_id, error: r.error, review_required: !!r.review_required,
  created_at: r.created_at, completed_at: r.completed_at, created_by: r.created_by, created_by_name: r.created_by_name ?? undefined,
});

export interface Completion { ok: boolean; replayed: boolean; distributorId?: number; endsAt?: Date; reason?: string; request: any }

/**
 * Turn a paid onboarding request into a live distributor. Runs inside the caller's transaction and is safe to call twice:
 * the request row is locked, and only an open one can be completed. If the phone or email was taken by someone else while
 * the payment was on its way, the request is marked failed (the money needs a human) instead of creating a clashing account.
 */
export async function completeOnboarding(c: Conn, id: number, o: { decidedBy: number | null; gatewayPaymentId?: string | null }): Promise<Completion> {
  const r = await q1<any>(c, 'SELECT * FROM onboarding_requests WHERE id = ? FOR UPDATE', [id]);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Onboarding request not found');
  if (r.status === 'completed') {
    const d = await q1<any>(c, 'SELECT subscription_ends_at FROM distributor_profiles WHERE user_id = ?', [r.distributor_id]);
    return { ok: true, replayed: true, distributorId: r.distributor_id, endsAt: d ? new Date(d.subscription_ends_at) : undefined, request: r };
  }
  if (!OPEN.includes(r.status)) throw new AppError(409, 'BAD_STATE', `This onboarding request is ${r.status}`);

  try { await assertIdentityFree(c, r.phone, r.email); } catch (e: any) {
    const why = e?.code === 'EMAIL_TAKEN' ? 'The email address was registered by someone else before the payment arrived.' : 'The phone number was registered by someone else before the payment arrived.';
    await exec(c, "UPDATE onboarding_requests SET status = 'failed', error = ?, gateway_payment_id = COALESCE(?, gateway_payment_id), decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?",
      [`${why} The fee was received: refund it or start again with other details.`.slice(0, 300), o.gatewayPaymentId ?? null, o.decidedBy, id]);
    return { ok: false, replayed: false, reason: why, request: { ...r, status: 'failed' } };
  }

  const ends = new Date(Date.now() + r.days * 86_400_000);          // the timer starts now, because the fee has arrived now
  const u = await exec(c, "INSERT INTO users (role, phone, email, name, password_hash, created_by) VALUES ('distributor',?,?,?,?,?)", [r.phone, r.email, r.owner_name, r.password_hash, r.created_by]);
  await exec(c, `INSERT INTO distributor_profiles (user_id, business_name, gst_no, address, city, pincode, permissions, subscription_ends_at, plan_name, review_required)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [u.insertId, r.business_name, r.gst_no, r.address, r.city, r.pincode, r.permissions, ends, r.plan_name, r.review_required]);
  const cats: number[] = JSON.parse(r.category_ids);
  if (cats.length) await exec(c, 'INSERT INTO distributor_categories (distributor_id, category_id) VALUES ?', [cats.map((x) => [u.insertId, x])]);
  // the fee is recorded like any other subscription payment, so revenue and the distributor's payment history include it
  await exec(c, `INSERT INTO subscription_payments (distributor_id, plan_id, plan_name, days, amount_paise, method, utr, gateway_ref, gateway_payment_id, status, idempotency_key, decided_by, decided_at, extended_to)
    VALUES (?,?,?,?,?,?,?,?,?, 'confirmed', ?, ?, UTC_TIMESTAMP(), ?)`,
    [u.insertId, r.plan_id, r.plan_name, r.days, r.amount_paise, r.method, r.utr, r.gateway_ref, o.gatewayPaymentId ?? r.gateway_payment_id, `onboard:${id}`, o.decidedBy, ends]);
  await exec(c, "UPDATE onboarding_requests SET status = 'completed', distributor_id = ?, gateway_payment_id = COALESCE(?, gateway_payment_id), decided_by = ?, decided_at = UTC_TIMESTAMP(), completed_at = UTC_TIMESTAMP(), error = NULL WHERE id = ?",
    [u.insertId, o.gatewayPaymentId ?? null, o.decidedBy, id]);
  return { ok: true, replayed: false, distributorId: u.insertId, endsAt: ends, request: { ...r, status: 'completed', distributor_id: u.insertId } };
}

/** After the transaction commits: the trail and the news. */
export async function afterOnboarding(done: Completion, decidedBy: number | null) {
  const r = done.request;
  if (done.replayed) return;
  if (done.ok) {
    await audit(decidedBy, 'onboarding.completed', 'user', done.distributorId!, { request_id: r.id, plan: r.plan_name, ends_at: done.endsAt?.toISOString(), onboarded_by: r.created_by });
    notifyUsers([r.created_by], 'Distributor is live', `${r.business_name} is active until ${done.endsAt?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`, { type: 'onboarding', id: r.id });
  } else {
    await audit(decidedBy, 'onboarding.needs_attention', 'onboarding', r.id, { reason: done.reason });
    notifyUsers([r.created_by], 'Onboarding needs attention', done.reason ?? 'The payment arrived but the account could not be created.', { type: 'onboarding', id: r.id });
  }
}
