import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { Conn, exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise, toPaise } from '../../utils/money';
import { assertSubscriptionActive } from '../distributors/subscription';
import { companyPayment, upiUri } from '../subscription/subscription.service';

/*
 * Distributors sell AAYME subscriptions to retailers (the retailer's online store) and earn commission.
 *   company -> distributor (sales partner) -> retailer (buys a subscription) -> end customers
 * The retailer pays the company (UPI, bank, cheque or cash); the admin confirms the payment; the retailer's subscription then starts and
 * the distributor's commission is credited. A refund reverses both. Commission is a percentage of the amount paid, set per plan, per
 * distributor, and per kind of sale (new subscription, renewal, upgrade); the admin can switch any kind off.
 */

type Kind = 'new' | 'renewal' | 'upgrade';
const KINDS: Kind[] = ['new', 'renewal', 'upgrade'];
const money = (v: unknown) => fromPaise(Number(v ?? 0));
const pct = (bps: number | null | undefined) => (bps == null ? null : Number(bps) / 100);
const bpsOf = (percent: number | null | undefined) => (percent == null ? null : Math.round(Number(percent) * 100));
const monthOf = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 7);   // Indian calendar month

const presentPlan = (p: any) => ({
  id: p.id, name: p.name, days: p.days, price: money(p.price_paise), description: p.description, features: p.features ? JSON.parse(p.features) : [],
  is_active: !!p.is_active, sort_order: p.sort_order,
  commission: { new: pct(p.commission_new_bps), renewal: pct(p.commission_renewal_bps), upgrade: pct(p.commission_upgrade_bps) },
});

/** Which kinds of sale pay commission at all (admin setting; all on unless switched off). */
export async function commissionSwitches(c: Conn = pool): Promise<Record<Kind, boolean>> {
  const rows = await q<any>(c, "SELECT name, value FROM platform_settings WHERE name IN ('rs_commission_on_new','rs_commission_on_renewal','rs_commission_on_upgrade')");
  const m = new Map<string, string>(rows.map((r) => [r.name, r.value]));
  return { new: m.get('rs_commission_on_new') !== '0', renewal: m.get('rs_commission_on_renewal') !== '0', upgrade: m.get('rs_commission_on_upgrade') !== '0' };
}

/** The commission rate (basis points) a distributor earns on a kind of sale of a plan: their rate for that plan, else their rate for all plans, else the plan's default. */
export async function commissionBps(c: Conn, distributorId: number, plan: any, kind: Kind): Promise<number> {
  if (!(await commissionSwitches(c))[kind]) return 0;
  const col = `${kind}_bps`;
  const rows = await q<any>(c, 'SELECT plan_id, new_bps, renewal_bps, upgrade_bps FROM distributor_commission_rates WHERE distributor_id = ? AND plan_key IN (0, ?) ORDER BY plan_key DESC', [distributorId, plan.id]);
  for (const r of rows) if (r[col] != null) return Number(r[col]);
  return Number(plan[`commission_${kind}_bps`] ?? 0);
}

/** The retailer's current subscription: the unexpired one that ends last. */
export async function currentSubscription(c: Conn, retailerId: number, lock = false) {
  return q1<any>(c, `SELECT * FROM retailer_subscriptions WHERE retailer_id = ? AND status = 'active' AND ends_at > UTC_TIMESTAMP() ORDER BY ends_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [retailerId]);
}

/** What buying this plan is for this retailer: a first subscription, a renewal, or an upgrade (a dearer plan while one is running, paying only the difference). */
export async function classify(c: Conn, retailerId: number, plan: any): Promise<{ kind: Kind; amount: number; previous?: any }> {
  const cur = await currentSubscription(c, retailerId);
  if (cur && Number(plan.price_paise) > Number(cur.price_paise)) return { kind: 'upgrade', amount: Number(plan.price_paise) - Number(cur.price_paise), previous: cur };
  const had = await q1<any>(c, "SELECT 1 FROM subscription_sales WHERE retailer_id = ? AND status = 'paid' LIMIT 1", [retailerId]);
  return { kind: had || cur ? 'renewal' : 'new', amount: Number(plan.price_paise) };
}

const presentSale = (s: any) => ({
  id: s.id, kind: s.kind, status: s.status, plan_id: s.plan_id, plan_name: s.plan_name, days: s.days, amount: money(s.amount_paise),
  method: s.method, reference: s.reference, note: s.note,
  commission_percent: pct(s.commission_bps), commission: money(s.commission_paise), commission_status: s.commission_status, clawback: !!s.clawback,
  retailer_id: s.retailer_id, shop_name: s.shop_name ?? undefined, retailer_name: s.retailer_name ?? undefined, retailer_phone: s.retailer_phone ?? undefined,
  distributor_id: s.distributor_id, business_name: s.business_name ?? undefined,
  created_at: s.created_at, paid_at: s.paid_at, refunded_at: s.refunded_at, decision_note: s.decision_note, settled_at: s.settled_at, settlement_ref: s.settlement_ref,
});
const SALE_SELECT = `SELECT s.*, rp.shop_name, ru.name retailer_name, ru.phone retailer_phone, dp.business_name FROM subscription_sales s
  JOIN users ru ON ru.id = s.retailer_id LEFT JOIN retailer_profiles rp ON rp.user_id = s.retailer_id LEFT JOIN distributor_profiles dp ON dp.user_id = s.distributor_id`;

// =============================================================================================
// Distributor
// =============================================================================================
export const distributorSalesRouter = Router();
distributorSalesRouter.use(authenticate, requireRole('distributor'));

// The plans on offer, with what THIS distributor earns on each kind of sale, and where the retailer pays.
distributorSalesRouter.get('/plans', asyncHandler(async (req, res) => {
  const d = req.auth!.userId;
  const plans = await q<any>(pool, 'SELECT * FROM retailer_plans WHERE is_active = 1 ORDER BY sort_order, price_paise');
  const out = [];
  for (const p of plans) out.push({ ...presentPlan(p), my_commission: { new: pct(await commissionBps(pool, d, p, 'new')), renewal: pct(await commissionBps(pool, d, p, 'renewal')), upgrade: pct(await commissionBps(pool, d, p, 'upgrade')) } });
  res.json({ plans: out, switches: await commissionSwitches(), pay_to: await companyPayment() });
}));

// ---- Retailer leads
const leadBody = z.object({
  name: z.string().trim().min(2).max(120), phone: z.string().regex(/^\d{10}$/, '10-digit phone'),
  shop_name: z.string().trim().max(190).optional(), city: z.string().trim().max(80).optional(), pincode: z.string().regex(/^\d{6}$/, 'Pincode is 6 digits').optional(),
  note: z.string().trim().max(500).optional(), status: z.enum(['new', 'contacted', 'interested', 'converted', 'lost']).optional(),
});
distributorSalesRouter.get('/leads', asyncHandler(async (req, res) => {
  const { status, q: text } = z.object({ status: z.enum(['new', 'contacted', 'interested', 'converted', 'lost']).optional(), q: z.string().trim().max(60).optional() }).parse(req.query);
  const where = ['distributor_id = ?']; const args: unknown[] = [req.auth!.userId];
  if (status) { where.push('status = ?'); args.push(status); }
  if (text) { where.push('(name LIKE ? OR phone LIKE ? OR shop_name LIKE ?)'); args.push(`%${text}%`, `%${text}%`, `%${text}%`); }
  const leads = await q<any>(pool, `SELECT * FROM retailer_leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, args);
  const counts = await q<any>(pool, 'SELECT status, COUNT(*) n FROM retailer_leads WHERE distributor_id = ? GROUP BY status', [req.auth!.userId]);
  res.json({ leads, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
}));
distributorSalesRouter.post('/leads', asyncHandler(async (req, res) => {
  const b = leadBody.parse(req.body); const d = req.auth!.userId;
  const r = await exec(pool, 'INSERT INTO retailer_leads (distributor_id, name, phone, shop_name, city, pincode, note, status) VALUES (?,?,?,?,?,?,?,?)', [d, b.name, b.phone, b.shop_name ?? null, b.city ?? null, b.pincode ?? null, b.note ?? null, b.status ?? 'new']);
  res.status(201).json(await q1(pool, 'SELECT * FROM retailer_leads WHERE id = ?', [r.insertId]));
}));
distributorSalesRouter.put('/leads/:id', asyncHandler(async (req, res) => {
  const b = leadBody.partial().parse(req.body); const id = idParam(req); const d = req.auth!.userId;
  const cur = await q1<any>(pool, 'SELECT * FROM retailer_leads WHERE id = ? AND distributor_id = ?', [id, d]);
  if (!cur) throw notFound('Lead');
  await exec(pool, 'UPDATE retailer_leads SET name=?, phone=?, shop_name=?, city=?, pincode=?, note=?, status=? WHERE id = ?', [
    b.name ?? cur.name, b.phone ?? cur.phone, b.shop_name === undefined ? cur.shop_name : b.shop_name, b.city === undefined ? cur.city : b.city, b.pincode === undefined ? cur.pincode : b.pincode,
    b.note === undefined ? cur.note : b.note, b.status ?? cur.status, id]);
  res.json(await q1(pool, 'SELECT * FROM retailer_leads WHERE id = ?', [id]));
}));
distributorSalesRouter.delete('/leads/:id', asyncHandler(async (req, res) => {
  const r = await exec(pool, "DELETE FROM retailer_leads WHERE id = ? AND distributor_id = ? AND status <> 'converted'", [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Lead');
  res.status(204).end();
}));

// ---- Sell a subscription
const sellBody = z.object({
  plan_id: z.number().int().positive(),
  retailer_id: z.number().int().positive().optional(),
  retailer: z.object({
    name: z.string().trim().min(2).max(120), phone: z.string().regex(/^\d{10}$/, '10-digit phone'), shop_name: z.string().trim().min(2).max(190),
    pincode: z.string().regex(/^\d{6}$/, 'Pincode is 6 digits'), address: z.string().trim().min(3).max(255).optional(), password: z.string().min(8).max(100).optional(),
  }).optional(),
  method: z.enum(['upi', 'bank', 'cheque', 'cash']).optional(),
  reference: z.string().trim().min(4).max(60).optional(),
  note: z.string().trim().max(200).optional(),
  lead_id: z.number().int().positive().optional(),
}).refine((v) => v.retailer_id || v.retailer, 'Choose an existing retailer or enter the new retailer’s details');

distributorSalesRouter.post('/sell', asyncHandler(async (req, res) => {
  const b = sellBody.parse(req.body); const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  const plan = await q1<any>(pool, 'SELECT * FROM retailer_plans WHERE id = ? AND is_active = 1', [b.plan_id]);
  if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'That plan is not available');
  if (b.method && b.method !== 'cash' && !b.reference) throw new AppError(400, 'REFERENCE_REQUIRED', 'Enter the payment reference (UPI UTR, bank reference or cheque number)');

  const out = await withTx(async (c) => {
    let retailerId = b.retailer_id ?? 0; let created = false; let generated: string | null = null;
    if (retailerId) {
      const ok = await q1(c, "SELECT 1 FROM users u JOIN retailer_distributor_relations r ON r.retailer_id = u.id AND r.distributor_id = ? AND r.status = 'active' WHERE u.id = ? AND u.role = 'retailer'", [d, retailerId]);
      if (!ok) throw new AppError(404, 'RETAILER_NOT_FOUND', 'That retailer is not one of yours');
    } else {
      const r = b.retailer!;
      const existing = await q1<any>(c, 'SELECT id, role FROM users WHERE phone = ?', [r.phone]);
      if (existing) {
        if (existing.role !== 'retailer') throw new AppError(409, 'PHONE_TAKEN', 'This phone number belongs to another kind of account');
        retailerId = existing.id;                                    // an AAYME retailer who is not yet a customer of this distributor: the sale still goes to them
      } else {
        generated = b.retailer!.password ?? null;
        const hash = await bcrypt.hash(generated ?? `Aayme@${Math.random().toString(36).slice(2, 10)}`, 10);
        const u = await exec(c, "INSERT INTO users (role, phone, name, password_hash, created_by) VALUES ('retailer',?,?,?,?)", [r.phone, r.name, hash, d]);
        await exec(c, 'INSERT INTO retailer_profiles (user_id, shop_name, pincode, address) VALUES (?,?,?,?)', [u.insertId, r.shop_name, r.pincode, r.address ?? null]);
        await exec(c, "INSERT INTO retailer_distributor_relations (retailer_id, distributor_id, is_primary, status, requested_by) VALUES (?,?,1,'active','distributor')", [u.insertId, d]);
        retailerId = u.insertId; created = true;
      }
    }
    if (await q1(c, "SELECT 1 FROM subscription_sales WHERE retailer_id = ? AND status IN ('awaiting_payment','payment_submitted') LIMIT 1", [retailerId]))
      throw new AppError(409, 'SALE_OPEN', 'This retailer already has a subscription waiting for payment. Finish or cancel that first.');
    const cls = await classify(c, retailerId, plan);
    const bps = await commissionBps(c, d, plan, cls.kind);
    const status = b.method && (b.reference || b.method === 'cash') ? 'payment_submitted' : 'awaiting_payment';
    const s = await exec(c, `INSERT INTO subscription_sales (distributor_id, retailer_id, plan_id, plan_name, days, kind, amount_paise, method, reference, note, status, commission_bps, lead_id, previous_plan_id, previous_plan_name, previous_price_paise)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [d, retailerId, plan.id, plan.name, plan.days, cls.kind, cls.amount, b.method ?? null, b.reference ?? null, b.note ?? null, status, bps, b.lead_id ?? null,
      cls.previous?.plan_id ?? null, cls.previous?.plan_name ?? null, cls.previous?.price_paise ?? null]);
    if (b.lead_id) await exec(c, "UPDATE retailer_leads SET status = 'interested', retailer_id = ? WHERE id = ? AND distributor_id = ? AND status IN ('new','contacted')", [retailerId, b.lead_id, d]);
    return { id: s.insertId as number, retailerId, created, kind: cls.kind, amount: cls.amount, status };
  });
  await audit(d, 'subscription_sale.create', 'subscription_sale', out.id, { retailer_id: out.retailerId, plan_id: plan.id, kind: out.kind, amount_paise: out.amount });
  if (out.status === 'payment_submitted') notifyAdmins(out.id, d).catch(() => {});
  const pay = await companyPayment();
  res.status(201).json({
    id: out.id, retailer_id: out.retailerId, retailer_created: out.created, kind: out.kind, amount: money(out.amount), status: out.status,
    pay_to: pay, upi_link: pay.upi_id ? upiUri(pay.upi_id, pay.payee, out.amount, `AAYME ${plan.name}`) : null,
  });
}));

async function notifyAdmins(saleId: number, distributorId: number) {
  const admins = await q<any>(pool, "SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
  const dp = await q1<any>(pool, 'SELECT business_name FROM distributor_profiles WHERE user_id = ?', [distributorId]);
  if (admins.length) notifyUsers(admins.map((a) => a.id), 'Subscription payment to confirm', `${dp?.business_name ?? 'A distributor'} submitted a retailer subscription payment (sale #${saleId}).`, { type: 'subscription_sale', id: saleId });
}

// The payment details for a sale that was created before the retailer paid.
distributorSalesRouter.post('/:id/payment', asyncHandler(async (req, res) => {
  const b = z.object({ method: z.enum(['upi', 'bank', 'cheque', 'cash']), reference: z.string().trim().min(4).max(60).optional() }).parse(req.body);
  if (b.method !== 'cash' && !b.reference) throw new AppError(400, 'REFERENCE_REQUIRED', 'Enter the payment reference (UPI UTR, bank reference or cheque number)');
  const id = idParam(req); const d = req.auth!.userId;
  const s = await q1<any>(pool, 'SELECT * FROM subscription_sales WHERE id = ? AND distributor_id = ?', [id, d]);
  if (!s) throw notFound('Sale');
  if (!['awaiting_payment', 'payment_submitted', 'rejected'].includes(s.status)) throw new AppError(409, 'NOT_OPEN', `This sale is already ${s.status.replace('_', ' ')}`);
  await exec(pool, "UPDATE subscription_sales SET method = ?, reference = ?, status = 'payment_submitted', decision_note = NULL WHERE id = ?", [b.method, b.reference ?? null, id]);
  notifyAdmins(id, d).catch(() => {});
  res.json(presentSale((await q1<any>(pool, `${SALE_SELECT} WHERE s.id = ?`, [id]))));
}));

distributorSalesRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  const r = await exec(pool, "UPDATE subscription_sales SET status = 'cancelled' WHERE id = ? AND distributor_id = ? AND status IN ('awaiting_payment','rejected')", [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw new AppError(409, 'NOT_OPEN', 'Only a sale that is still waiting for payment can be cancelled');
  res.json({ status: 'cancelled' });
}));

// ---- Sales history
distributorSalesRouter.get('/history', asyncHandler(async (req, res) => {
  const qs = z.object({ status: z.enum(['awaiting_payment', 'payment_submitted', 'paid', 'rejected', 'cancelled', 'refunded']).optional(), q: z.string().trim().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const where = ['s.distributor_id = ?']; const args: unknown[] = [req.auth!.userId];
  if (qs.status) { where.push('s.status = ?'); args.push(qs.status); }
  if (qs.q) { where.push('(rp.shop_name LIKE ? OR ru.name LIKE ? OR ru.phone LIKE ?)'); args.push(`%${qs.q}%`, `%${qs.q}%`, `%${qs.q}%`); }
  const rows = await q<any>(pool, `${SALE_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ? OFFSET ?`, [...args, qs.limit, qs.offset]);
  res.json({ sales: rows.map(presentSale) });
}));

// ---- My earnings
distributorSalesRouter.get('/earnings', asyncHandler(async (req, res) => {
  const d = req.auth!.userId;
  const tot = (await q1<any>(pool, `SELECT
      COALESCE(SUM(CASE WHEN commission_status = 'accrued' THEN commission_paise END),0) pending,
      COALESCE(SUM(CASE WHEN commission_status = 'settled' THEN commission_paise END),0) settled,
      COALESCE(SUM(CASE WHEN clawback = 1 THEN commission_paise END),0) to_recover,
      COUNT(CASE WHEN status = 'paid' THEN 1 END) paid_sales, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_paise END),0) sales_value,
      COUNT(CASE WHEN status IN ('awaiting_payment','payment_submitted') THEN 1 END) open_sales
    FROM subscription_sales WHERE distributor_id = ?`, [d]))!;
  const byMonth = await q<any>(pool, `SELECT DATE_FORMAT(CONVERT_TZ(paid_at,'+00:00','+05:30'), '%Y-%m') month, COUNT(*) sales, SUM(amount_paise) amount, SUM(commission_paise) commission
    FROM subscription_sales WHERE distributor_id = ? AND status = 'paid' GROUP BY month ORDER BY month DESC LIMIT 12`, [d]);
  const byKind = await q<any>(pool, "SELECT kind, COUNT(*) sales, SUM(commission_paise) commission FROM subscription_sales WHERE distributor_id = ? AND status = 'paid' GROUP BY kind", [d]);
  res.json({
    pending: money(tot.pending), settled: money(tot.settled), total: money(Number(tot.pending) + Number(tot.settled)), to_recover: money(tot.to_recover),
    paid_sales: Number(tot.paid_sales), sales_value: money(tot.sales_value), open_sales: Number(tot.open_sales),
    by_month: byMonth.map((m) => ({ month: m.month, sales: Number(m.sales), amount: money(m.amount), commission: money(m.commission) })),
    by_kind: byKind.map((k) => ({ kind: k.kind, sales: Number(k.sales), commission: money(k.commission) })),
  });
}));

// ---- Performance against the monthly target
distributorSalesRouter.get('/performance', asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const now = new Date(); const thisMonth = monthOf(now);
  const targets = await q<any>(pool, 'SELECT month, target_amount_paise, target_count FROM distributor_targets WHERE distributor_id = ? ORDER BY month DESC LIMIT 6', [d]);
  const done = await q<any>(pool, `SELECT DATE_FORMAT(CONVERT_TZ(paid_at,'+00:00','+05:30'), '%Y-%m') month, COUNT(*) n, COALESCE(SUM(amount_paise),0) amount, COALESCE(SUM(commission_paise),0) commission
    FROM subscription_sales WHERE distributor_id = ? AND status = 'paid' GROUP BY month ORDER BY month DESC LIMIT 6`, [d]);
  const months = [...new Set([thisMonth, ...targets.map((t) => t.month), ...done.map((x) => x.month)])].sort().reverse().slice(0, 6);
  const row = (m: string) => {
    const t = targets.find((x) => x.month === m); const x = done.find((y) => y.month === m);
    const amount = Number(x?.amount ?? 0); const count = Number(x?.n ?? 0); const ta = Number(t?.target_amount_paise ?? 0); const tc = Number(t?.target_count ?? 0);
    return { month: m, sales: count, amount: money(amount), commission: money(x?.commission), target_amount: money(ta), target_count: tc,
      amount_progress: ta ? Math.min(100, Math.round((amount / ta) * 100)) : null, count_progress: tc ? Math.min(100, Math.round((count / tc) * 100)) : null };
  };
  const leads = await q<any>(pool, 'SELECT status, COUNT(*) n FROM retailer_leads WHERE distributor_id = ? GROUP BY status', [d]);
  const converted = Number(leads.find((l) => l.status === 'converted')?.n ?? 0); const totalLeads = leads.reduce((s, l) => s + Number(l.n), 0);
  res.json({ this_month: row(thisMonth), months: months.map(row), leads: { total: totalLeads, converted, conversion_percent: totalLeads ? Math.round((converted / totalLeads) * 100) : 0 } });
}));

// =============================================================================================
// A retailer's own subscription (read only)
// =============================================================================================
export const retailerSubscriptionRouter = Router();
retailerSubscriptionRouter.get('/', authenticate, requireRole('retailer'), asyncHandler(async (req, res) => {
  const me = req.auth!.userId;
  const cur = await currentSubscription(pool, me);
  const history = await q<any>(pool, 'SELECT id, plan_name, price_paise, starts_at, ends_at, status FROM retailer_subscriptions WHERE retailer_id = ? ORDER BY id DESC LIMIT 20', [me]);
  res.json({
    active: !!cur, current: cur ? { plan_name: cur.plan_name, ends_at: cur.ends_at, days_left: Math.max(0, Math.ceil((+new Date(cur.ends_at) - Date.now()) / 86400_000)) } : null,
    history: history.map((h) => ({ id: h.id, plan_name: h.plan_name, price: money(h.price_paise), starts_at: h.starts_at, ends_at: h.ends_at, status: h.status })),
  });
}));

// =============================================================================================
// Admin (mounted inside the admin router: auth, role and 2FA already applied)
// =============================================================================================
export const adminRetailerSalesRouter = Router();

const planBody = z.object({
  name: z.string().trim().min(2).max(60), days: z.number().int().min(1).max(3650), price: z.union([z.string(), z.number()]),
  description: z.string().trim().max(200).nullable().optional(), features: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
  is_active: z.boolean().default(true), sort_order: z.number().int().min(0).max(1000).default(0),
  commission_new: z.number().min(0).max(100).default(0), commission_renewal: z.number().min(0).max(100).default(0), commission_upgrade: z.number().min(0).max(100).default(0),
});
adminRetailerSalesRouter.get('/retailer-plans', asyncHandler(async (_req, res) => {
  res.json({ plans: (await q<any>(pool, 'SELECT * FROM retailer_plans ORDER BY sort_order, price_paise')).map(presentPlan), switches: await commissionSwitches() });
}));
adminRetailerSalesRouter.post('/retailer-plans', asyncHandler(async (req, res) => {
  const b = planBody.parse(req.body); const price = toPaise(b.price);
  if (price <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Price must be more than zero');
  const r = await exec(pool, 'INSERT INTO retailer_plans (name, days, price_paise, description, features, is_active, sort_order, commission_new_bps, commission_renewal_bps, commission_upgrade_bps) VALUES (?,?,?,?,?,?,?,?,?,?)', [
    b.name, b.days, price, b.description ?? null, b.features ? JSON.stringify(b.features) : null, b.is_active ? 1 : 0, b.sort_order, bpsOf(b.commission_new), bpsOf(b.commission_renewal), bpsOf(b.commission_upgrade)]);
  await audit(req.auth!.userId, 'retailer_plan.create', 'retailer_plan', r.insertId, { name: b.name, price_paise: price });
  res.status(201).json(presentPlan(await q1<any>(pool, 'SELECT * FROM retailer_plans WHERE id = ?', [r.insertId])));
}));
// Changing a plan never changes a past sale: each sale keeps its own copy of the name, validity and price.
adminRetailerSalesRouter.put('/retailer-plans/:id', asyncHandler(async (req, res) => {
  const b = planBody.partial().parse(req.body); const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM retailer_plans WHERE id = ?', [id]);
  if (!cur) throw notFound('Plan');
  const price = b.price === undefined ? Number(cur.price_paise) : toPaise(b.price);
  if (price <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Price must be more than zero');
  await exec(pool, `UPDATE retailer_plans SET name=?, days=?, price_paise=?, description=?, features=?, is_active=?, sort_order=?, commission_new_bps=?, commission_renewal_bps=?, commission_upgrade_bps=? WHERE id = ?`, [
    b.name ?? cur.name, b.days ?? cur.days, price, b.description === undefined ? cur.description : b.description, b.features === undefined ? cur.features : JSON.stringify(b.features),
    b.is_active === undefined ? cur.is_active : b.is_active ? 1 : 0, b.sort_order ?? cur.sort_order,
    b.commission_new === undefined ? cur.commission_new_bps : bpsOf(b.commission_new), b.commission_renewal === undefined ? cur.commission_renewal_bps : bpsOf(b.commission_renewal),
    b.commission_upgrade === undefined ? cur.commission_upgrade_bps : bpsOf(b.commission_upgrade), id]);
  await audit(req.auth!.userId, 'retailer_plan.update', 'retailer_plan', id, b);
  res.json(presentPlan(await q1<any>(pool, 'SELECT * FROM retailer_plans WHERE id = ?', [id])));
}));

// Which kinds of sale pay commission.
adminRetailerSalesRouter.get('/retailer-sales/settings', asyncHandler(async (_req, res) => { res.json({ switches: await commissionSwitches() }); }));
adminRetailerSalesRouter.put('/retailer-sales/settings', asyncHandler(async (req, res) => {
  const b = z.object({ new: z.boolean().optional(), renewal: z.boolean().optional(), upgrade: z.boolean().optional() }).parse(req.body);
  for (const k of KINDS) if (b[k] !== undefined) await exec(pool, 'INSERT INTO platform_settings (name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [`rs_commission_on_${k}`, b[k] ? '1' : '0']);
  await audit(req.auth!.userId, 'retailer_sales.settings', 'settings', null, b);
  res.json({ switches: await commissionSwitches() });
}));

// A distributor's own commission rates and monthly targets.
const rateBody = z.object({ plan_id: z.number().int().positive().nullable().default(null), new: z.number().min(0).max(100).nullable().optional(), renewal: z.number().min(0).max(100).nullable().optional(), upgrade: z.number().min(0).max(100).nullable().optional() });
adminRetailerSalesRouter.get('/distributors/:id/sales-setup', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const rates = await q<any>(pool, 'SELECT plan_id, new_bps, renewal_bps, upgrade_bps FROM distributor_commission_rates WHERE distributor_id = ? ORDER BY plan_key', [id]);
  const targets = await q<any>(pool, 'SELECT month, target_amount_paise, target_count FROM distributor_targets WHERE distributor_id = ? ORDER BY month DESC LIMIT 12', [id]);
  res.json({
    rates: rates.map((r) => ({ plan_id: r.plan_id, new: pct(r.new_bps), renewal: pct(r.renewal_bps), upgrade: pct(r.upgrade_bps) })),
    targets: targets.map((t) => ({ month: t.month, target_amount: money(t.target_amount_paise), target_count: t.target_count })),
  });
}));
adminRetailerSalesRouter.put('/distributors/:id/commission-rates', asyncHandler(async (req, res) => {
  const b = rateBody.parse(req.body); const id = idParam(req);
  if (!(await q1(pool, "SELECT 1 FROM users WHERE id = ? AND role = 'distributor'", [id]))) throw notFound('Distributor');
  if (b.plan_id && !(await q1(pool, 'SELECT 1 FROM retailer_plans WHERE id = ?', [b.plan_id]))) throw notFound('Plan');
  if (b.new == null && b.renewal == null && b.upgrade == null) {
    await exec(pool, 'DELETE FROM distributor_commission_rates WHERE distributor_id = ? AND plan_key = ?', [id, b.plan_id ?? 0]);       // nothing set: back to the plan's default
  } else {
    await exec(pool, `INSERT INTO distributor_commission_rates (distributor_id, plan_id, plan_key, new_bps, renewal_bps, upgrade_bps) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE new_bps = VALUES(new_bps), renewal_bps = VALUES(renewal_bps), upgrade_bps = VALUES(upgrade_bps)`, [id, b.plan_id, b.plan_id ?? 0, bpsOf(b.new), bpsOf(b.renewal), bpsOf(b.upgrade)]);
  }
  await audit(req.auth!.userId, 'distributor.commission_rates', 'user', id, b);
  res.json({ ok: true });
}));
adminRetailerSalesRouter.put('/distributors/:id/targets', asyncHandler(async (req, res) => {
  const b = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month looks like 2026-11'), target_amount: z.union([z.string(), z.number()]).default(0), target_count: z.number().int().min(0).max(100000).default(0) }).parse(req.body);
  const id = idParam(req);
  if (!(await q1(pool, "SELECT 1 FROM users WHERE id = ? AND role = 'distributor'", [id]))) throw notFound('Distributor');
  await exec(pool, 'INSERT INTO distributor_targets (distributor_id, month, target_amount_paise, target_count) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE target_amount_paise = VALUES(target_amount_paise), target_count = VALUES(target_count)', [id, b.month, toPaise(b.target_amount), b.target_count]);
  await audit(req.auth!.userId, 'distributor.target', 'user', id, b);
  res.json({ ok: true });
}));

// Payments to confirm, and every sale.
adminRetailerSalesRouter.get('/subscription-sales', asyncHandler(async (req, res) => {
  const qs = z.object({ status: z.enum(['open', 'awaiting_payment', 'payment_submitted', 'paid', 'rejected', 'cancelled', 'refunded', 'all']).default('payment_submitted'), distributor_id: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  const where: string[] = []; const args: unknown[] = [];
  if (qs.status === 'open') where.push("s.status IN ('awaiting_payment','payment_submitted')"); else if (qs.status !== 'all') { where.push('s.status = ?'); args.push(qs.status); }
  if (qs.distributor_id) { where.push('s.distributor_id = ?'); args.push(qs.distributor_id); }
  const rows = await q<any>(pool, `${SALE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ?`, [...args, qs.limit]);
  res.json({ sales: rows.map(presentSale) });
}));

adminRetailerSalesRouter.post('/subscription-sales/:id/confirm', asyncHandler(async (req, res) => {
  const id = idParam(req); const admin = req.auth!.userId;
  const out = await withTx(async (c) => {
    const s = await q1<any>(c, 'SELECT * FROM subscription_sales WHERE id = ? FOR UPDATE', [id]);
    if (!s) throw notFound('Sale');
    if (s.status === 'paid') return { sale: s, replayed: true };
    if (!['awaiting_payment', 'payment_submitted'].includes(s.status)) throw new AppError(409, 'ALREADY_DECIDED', `This sale is already ${s.status.replace('_', ' ')}`);
    const cur = await currentSubscription(c, s.retailer_id, true);
    const now = new Date();
    let subId: number;
    if (s.kind === 'upgrade' && cur) {
      // the better plan starts at once and runs out when the paid period would have
      await exec(c, 'UPDATE retailer_subscriptions SET plan_id = ?, plan_name = ?, price_paise = (SELECT price_paise FROM retailer_plans WHERE id = ?) WHERE id = ?', [s.plan_id, s.plan_name, s.plan_id, cur.id]);
      subId = cur.id;
    } else {
      const start = cur ? Math.max(now.getTime(), +new Date(cur.ends_at)) : now.getTime();      // paying early never wastes days
      const plan = await q1<any>(c, 'SELECT price_paise FROM retailer_plans WHERE id = ?', [s.plan_id]);
      const r = await exec(c, 'INSERT INTO retailer_subscriptions (retailer_id, plan_id, plan_name, price_paise, starts_at, ends_at, sold_by, sale_id) VALUES (?,?,?,?,?,?,?,?)', [
        s.retailer_id, s.plan_id, s.plan_name, plan?.price_paise ?? s.amount_paise, new Date(start), new Date(start + s.days * 86400_000), s.distributor_id, s.id]);
      subId = r.insertId;
    }
    const commission = Math.round((Number(s.amount_paise) * Number(s.commission_bps)) / 10000);
    await exec(c, "UPDATE subscription_sales SET status = 'paid', paid_at = UTC_TIMESTAMP(), decided_by = ?, decided_at = UTC_TIMESTAMP(), subscription_id = ?, commission_paise = ?, commission_status = ? WHERE id = ?",
      [admin, subId, commission, commission > 0 ? 'accrued' : 'none', id]);
    if (s.lead_id) await exec(c, "UPDATE retailer_leads SET status = 'converted', retailer_id = ? WHERE id = ? AND distributor_id = ?", [s.retailer_id, s.lead_id, s.distributor_id]);
    return { sale: { ...s, commission_paise: commission }, replayed: false };
  });
  if (!out.replayed) {
    await audit(admin, 'subscription_sale.confirm', 'subscription_sale', id, { distributor_id: out.sale.distributor_id, retailer_id: out.sale.retailer_id });
    const c = Number(out.sale.commission_paise);
    notifyUsers([out.sale.distributor_id], 'Subscription activated', `Sale #${id} (${out.sale.plan_name}) is confirmed${c > 0 ? `. ₹${money(c)} commission added to your earnings` : ''}.`, { type: 'subscription_sale', id });
    notifyUsers([out.sale.retailer_id], 'Your AAYME subscription is active', `Your ${out.sale.plan_name} plan is now active.`, { type: 'subscription' });
  }
  res.json({ status: 'paid', replayed: out.replayed });
}));

adminRetailerSalesRouter.post('/subscription-sales/:id/reject', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body ?? {});
  const id = idParam(req);
  const s = await q1<any>(pool, 'SELECT * FROM subscription_sales WHERE id = ?', [id]);
  if (!s) throw notFound('Sale');
  if (!['awaiting_payment', 'payment_submitted'].includes(s.status)) throw new AppError(409, 'ALREADY_DECIDED', `This sale is already ${s.status.replace('_', ' ')}`);
  await exec(pool, "UPDATE subscription_sales SET status = 'rejected', decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ? WHERE id = ?", [req.auth!.userId, note ?? null, id]);
  await audit(req.auth!.userId, 'subscription_sale.reject', 'subscription_sale', id, { note });
  notifyUsers([s.distributor_id], 'Subscription payment not found', note ?? `We could not find the payment for sale #${id}. Check the reference and submit it again.`, { type: 'subscription_sale', id });
  res.json({ status: 'rejected' });
}));

// Refund or cancellation: the subscription ends and the commission is reversed (flagged for recovery if it was already paid out).
adminRetailerSalesRouter.post('/subscription-sales/:id/refund', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body ?? {});
  const id = idParam(req); const admin = req.auth!.userId;
  const s = await withTx(async (c) => {
    const row = await q1<any>(c, 'SELECT * FROM subscription_sales WHERE id = ? FOR UPDATE', [id]);
    if (!row) throw notFound('Sale');
    if (row.status !== 'paid') throw new AppError(409, 'NOT_PAID', 'Only a paid sale can be refunded');
    if (row.subscription_id) {
      if (row.kind === 'upgrade' && row.previous_plan_id) {
        await exec(c, 'UPDATE retailer_subscriptions SET plan_id = ?, plan_name = ?, price_paise = ? WHERE id = ?', [row.previous_plan_id, row.previous_plan_name, row.previous_price_paise, row.subscription_id]);   // back to the plan they were on
      } else {
        await exec(c, "UPDATE retailer_subscriptions SET status = 'cancelled', ends_at = LEAST(ends_at, UTC_TIMESTAMP()) WHERE id = ?", [row.subscription_id]);
      }
    }
    const settled = row.commission_status === 'settled';
    await exec(c, `UPDATE subscription_sales SET status = 'refunded', refunded_at = UTC_TIMESTAMP(), decision_note = ?, decided_by = ?,
      commission_status = CASE WHEN commission_status IN ('accrued','settled') THEN 'reversed' ELSE commission_status END, clawback = ? WHERE id = ?`, [note ?? null, admin, settled ? 1 : 0, id]);
    return row;
  });
  await audit(admin, 'subscription_sale.refund', 'subscription_sale', id, { note });
  notifyUsers([s.distributor_id], 'Subscription refunded', `Sale #${id} was refunded. Its commission was taken back.`, { type: 'subscription_sale', id });
  res.json({ status: 'refunded' });
}));

// Pay out what a distributor has earned: marks their accrued commission as settled.
adminRetailerSalesRouter.post('/subscription-sales/payouts', asyncHandler(async (req, res) => {
  const b = z.object({ distributor_id: z.number().int().positive(), reference: z.string().trim().min(2).max(80), note: z.string().trim().max(200).optional() }).parse(req.body);
  const sum = await q1<any>(pool, "SELECT COALESCE(SUM(commission_paise),0) amount, COUNT(*) n FROM subscription_sales WHERE distributor_id = ? AND commission_status = 'accrued'", [b.distributor_id]);
  if (!Number(sum!.n)) throw new AppError(409, 'NOTHING_TO_PAY', 'This distributor has no commission waiting to be paid');
  await exec(pool, "UPDATE subscription_sales SET commission_status = 'settled', settled_at = UTC_TIMESTAMP(), settlement_ref = ? WHERE distributor_id = ? AND commission_status = 'accrued'", [b.reference, b.distributor_id]);
  await audit(req.auth!.userId, 'commission_payout.retailer_sales', 'user', b.distributor_id, { amount_paise: Number(sum!.amount), reference: b.reference });
  notifyUsers([b.distributor_id], 'Commission paid', `₹${money(sum!.amount)} commission was paid out (ref ${b.reference}).`, { type: 'subscription_sale' });
  res.json({ paid: money(sum!.amount), sales: Number(sum!.n) });
}));

// Activation and expiry of every retailer subscription.
adminRetailerSalesRouter.get('/retailer-subscriptions', asyncHandler(async (req, res) => {
  const { state } = z.object({ state: z.enum(['active', 'expiring', 'expired', 'all']).default('all') }).parse(req.query);
  const where = state === 'active' ? "rs.status = 'active' AND rs.ends_at > UTC_TIMESTAMP()" : state === 'expiring' ? "rs.status = 'active' AND rs.ends_at > UTC_TIMESTAMP() AND rs.ends_at < DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY)"
    : state === 'expired' ? "(rs.status = 'cancelled' OR rs.ends_at <= UTC_TIMESTAMP())" : '1=1';
  const rows = await q<any>(pool, `SELECT rs.*, rp.shop_name, u.phone, u.name retailer_name, dp.business_name FROM retailer_subscriptions rs JOIN users u ON u.id = rs.retailer_id
    LEFT JOIN retailer_profiles rp ON rp.user_id = rs.retailer_id LEFT JOIN distributor_profiles dp ON dp.user_id = rs.sold_by WHERE ${where} ORDER BY rs.ends_at LIMIT 200`);
  res.json({ subscriptions: rows.map((r) => ({ id: r.id, retailer_id: r.retailer_id, shop_name: r.shop_name, retailer_name: r.retailer_name, phone: r.phone, plan_name: r.plan_name, price: money(r.price_paise),
    starts_at: r.starts_at, ends_at: r.ends_at, status: r.status, active: r.status === 'active' && +new Date(r.ends_at) > Date.now(), sold_by: r.business_name })) });
}));

// Distributor-wise sales report.
adminRetailerSalesRouter.get('/retailer-sales/report', asyncHandler(async (req, res) => {
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const { from, to } = z.object({ from: day.optional(), to: day.optional() }).parse(req.query);
  const where = ['1=1']; const args: unknown[] = [];
  if (from) { where.push("CONVERT_TZ(s.created_at,'+00:00','+05:30') >= ?"); args.push(`${from} 00:00:00`); }
  if (to) { where.push("CONVERT_TZ(s.created_at,'+00:00','+05:30') < DATE_ADD(?, INTERVAL 1 DAY)"); args.push(`${to} 00:00:00`); }
  const rows = await q<any>(pool, `SELECT s.distributor_id, dp.business_name, u.phone,
      SUM(s.status = 'paid') paid, SUM(CASE WHEN s.status = 'paid' THEN s.amount_paise ELSE 0 END) amount,
      SUM(s.status = 'paid' AND s.kind = 'new') n_new, SUM(s.status = 'paid' AND s.kind = 'renewal') n_renewal, SUM(s.status = 'paid' AND s.kind = 'upgrade') n_upgrade,
      SUM(s.status = 'refunded') refunded, SUM(CASE WHEN s.status = 'refunded' THEN s.amount_paise ELSE 0 END) refunded_amount,
      SUM(s.status IN ('awaiting_payment','payment_submitted')) open_sales,
      SUM(CASE WHEN s.commission_status = 'accrued' THEN s.commission_paise ELSE 0 END) commission_pending, SUM(CASE WHEN s.commission_status = 'settled' THEN s.commission_paise ELSE 0 END) commission_settled,
      SUM(CASE WHEN s.clawback = 1 THEN s.commission_paise ELSE 0 END) to_recover
    FROM subscription_sales s JOIN distributor_profiles dp ON dp.user_id = s.distributor_id JOIN users u ON u.id = s.distributor_id WHERE ${where.join(' AND ')}
    GROUP BY s.distributor_id, dp.business_name, u.phone ORDER BY amount DESC`, args);
  res.json({ distributors: rows.map((r) => ({
    distributor_id: r.distributor_id, business_name: r.business_name, phone: r.phone, paid_sales: Number(r.paid), amount: money(r.amount),
    new: Number(r.n_new), renewal: Number(r.n_renewal), upgrade: Number(r.n_upgrade), refunded: Number(r.refunded), refunded_amount: money(r.refunded_amount), open_sales: Number(r.open_sales),
    commission_pending: money(r.commission_pending), commission_settled: money(r.commission_settled), to_recover: money(r.to_recover),
  })) });
}));
