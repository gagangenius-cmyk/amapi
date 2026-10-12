import { Conn, exec, pool, q1 } from '../../db/pool';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';

/** Where distributors send the subscription fee. The admin sets it in the console; environment variables are the fallback. */
export async function companyPayment() {
  const rows = await pool.query<any[]>("SELECT name, value FROM platform_settings WHERE name IN ('company_upi_id','company_payee')");
  const m = new Map<string, string>((rows[0] as any[]).map((r) => [r.name, r.value]));
  const upi = m.get('company_upi_id') ?? process.env.COMPANY_UPI_ID ?? null;
  const payee = m.get('company_payee') ?? process.env.COMPANY_PAYEE_NAME ?? 'AAYME';
  return { upi_id: upi, payee };
}

export const upiUri = (upi: string, payee: string, amountPaise: number, note: string) =>
  `upi://pay?${new URLSearchParams({ pa: upi, pn: payee, am: (amountPaise / 100).toFixed(2), cu: 'INR', tn: note.slice(0, 40) }).toString()}`;

/**
 * Turn a paid subscription payment into validity. Runs inside the caller's transaction and is safe to call twice:
 * the payment row is locked and only a pending one can be confirmed. The new period starts when the old one ends
 * (or now, if it already ended), so paying early never wastes days.
 */
export async function confirmSubscriptionPayment(c: Conn, paymentId: number, decidedBy: number | null) {
  const p = await q1<any>(c, 'SELECT * FROM subscription_payments WHERE id = ? FOR UPDATE', [paymentId]);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Payment not found');
  if (p.status === 'confirmed') return { payment: p, replayed: true, ends_at: p.extended_to as Date };
  if (p.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', `Payment already ${p.status}`);
  const d = (await q1<any>(c, 'SELECT subscription_ends_at FROM distributor_profiles WHERE user_id = ? FOR UPDATE', [p.distributor_id]))!;
  const start = Math.max(Date.now(), +new Date(d.subscription_ends_at));
  const ends = new Date(start + p.days * 86400_000);
  await exec(c, 'UPDATE distributor_profiles SET subscription_ends_at = ?, plan_name = ?, expiry_warned_at = NULL WHERE user_id = ?', [ends, p.plan_name, p.distributor_id]);
  await exec(c, "UPDATE subscription_payments SET status = 'confirmed', decided_by = ?, decided_at = UTC_TIMESTAMP(), extended_to = ? WHERE id = ?", [decidedBy, ends, p.id]);
  return { payment: { ...p, status: 'confirmed' }, replayed: false, ends_at: ends };
}

export async function afterConfirm(paymentId: number, distributorId: number, endsAt: Date, planName: string, decidedBy: number | null) {
  await audit(decidedBy, 'subscription.confirmed', 'distributor', distributorId, { payment_id: paymentId, plan: planName, ends_at: endsAt.toISOString() });
  notifyUsers([distributorId], 'Subscription active', `${planName} plan is active until ${endsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. Thank you!`, { type: 'subscription' });
}
