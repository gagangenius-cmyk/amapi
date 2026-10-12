import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1 } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise, toPaise } from '../../utils/money';
import { assertPermission } from '../distributors/subscription';
import { Aging, computeAging } from '../ledger/aging';

/** Credit terms, receivables aging and payment reminders. Distributor-only: it is their money picture. */
export const collectionsRouter = Router();
collectionsRouter.use(authenticate, requireRole('distributor'));

const REMIND_EVERY_HOURS = 24;
const presentAging = (a: Aging) => ({
  not_due: fromPaise(a.not_due), d1_30: fromPaise(a.d1_30), d31_60: fromPaise(a.d31_60), d61_90: fromPaise(a.d61_90), d90_plus: fromPaise(a.d90_plus),
  overdue: fromPaise(a.overdue), total_due: fromPaise(a.total_due), advance: fromPaise(a.advance), oldest_overdue_days: a.oldest_overdue_days,
});

/** Aging for every retailer who currently owes money. One ledger scan for the whole book. */
export async function receivablesOf(distributorId: number, now = new Date()) {
  const rels = await q<any>(pool, `
    SELECT rdr.retailer_id, rdr.balance_due_paise, rdr.credit_limit_paise, rdr.credit_days, rp.shop_name, u.phone,
           (SELECT MAX(created_at) FROM collection_reminders cr WHERE cr.distributor_id = rdr.distributor_id AND cr.retailer_id = rdr.retailer_id) AS last_reminded_at
    FROM retailer_distributor_relations rdr JOIN retailer_profiles rp ON rp.user_id = rdr.retailer_id JOIN users u ON u.id = rdr.retailer_id
    WHERE rdr.distributor_id = ? AND rdr.status = 'active' AND rdr.balance_due_paise > 0`, [distributorId]);
  if (!rels.length) return [];
  const rows = await q<any>(pool, 'SELECT id, reversal_of, retailer_id, delta_paise, created_at FROM ledger_transactions WHERE distributor_id = ? AND retailer_id IN (?) ORDER BY id', [distributorId, rels.map((r) => r.retailer_id)]);
  const by = new Map<number, any[]>();
  for (const r of rows) (by.get(r.retailer_id) ?? by.set(r.retailer_id, []).get(r.retailer_id)!).push(r);
  return rels.map((r) => ({ rel: r, aging: computeAging(by.get(r.retailer_id) ?? [], now, r.credit_days) }));
}

collectionsRouter.get('/receivables', asyncHandler(async (req, res) => {
  const list = await receivablesOf(req.auth!.userId);
  const totals = list.reduce((t, x) => ({
    total_due: t.total_due + x.aging.total_due, overdue: t.overdue + x.aging.overdue, d1_30: t.d1_30 + x.aging.d1_30, d31_60: t.d31_60 + x.aging.d31_60,
    d61_90: t.d61_90 + x.aging.d61_90, d90_plus: t.d90_plus + x.aging.d90_plus, not_due: t.not_due + x.aging.not_due,
  }), { total_due: 0, overdue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, not_due: 0 });
  list.sort((a, b) => b.aging.overdue - a.aging.overdue || b.aging.total_due - a.aging.total_due);
  res.json({
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, fromPaise(v)])),
    retailers: list.map(({ rel, aging }) => ({
      retailer_id: rel.retailer_id, shop_name: rel.shop_name, phone: rel.phone,
      credit_limit: rel.credit_limit_paise == null ? null : fromPaise(Number(rel.credit_limit_paise)), credit_days: rel.credit_days,
      last_reminded_at: rel.last_reminded_at, can_remind: !rel.last_reminded_at || Date.now() - +new Date(rel.last_reminded_at) > REMIND_EVERY_HOURS * 3600_000,
      ...presentAging(aging),
    })),
  });
}));

// Terms are per retailer<->distributor pair. credit_limit = null removes the limit.
collectionsRouter.put('/terms/:retailerId', asyncHandler(async (req, res) => {
  const b = z.object({
    credit_limit: z.union([z.string(), z.number()]).nullable().optional(),
    credit_days: z.number().int().min(0).max(365).optional(),
  }).refine((v) => v.credit_limit !== undefined || v.credit_days !== undefined, 'Nothing to change').parse(req.body);
  const retailerId = idParam(req, 'retailerId');
  const d = req.auth!.userId;
  const rel = await q1<any>(pool, "SELECT id FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active'", [retailerId, d]);
  if (!rel) throw notFound('Retailer');
  const limit = b.credit_limit === undefined ? undefined : b.credit_limit === null || b.credit_limit === '' ? null : toPaise(b.credit_limit);
  if (limit !== undefined && limit !== null && limit <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Credit limit must be positive (or empty for no limit)');
  await exec(pool, `UPDATE retailer_distributor_relations SET
      credit_limit_paise = IF(?, ?, credit_limit_paise), credit_days = COALESCE(?, credit_days) WHERE id = ?`, [limit === undefined ? 0 : 1, limit ?? null, b.credit_days ?? null, rel.id]);
  await audit(d, 'relation.terms', 'user', retailerId, { credit_limit: limit === undefined ? undefined : limit, credit_days: b.credit_days });
  const row = await q1<any>(pool, 'SELECT credit_limit_paise, credit_days FROM retailer_distributor_relations WHERE id = ?', [rel.id]);
  res.json({ credit_limit: row.credit_limit_paise == null ? null : fromPaise(Number(row.credit_limit_paise)), credit_days: row.credit_days });
}));

/** Sends one reminder unless one already went out in the last 24 h. Returns false when it was skipped. */
export async function sendReminder(distributorId: number, businessName: string, retailerId: number, amountPaise: number, source: 'manual' | 'auto', overdue = false) {
  const recent = await q1(pool, 'SELECT 1 FROM collection_reminders WHERE distributor_id = ? AND retailer_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)', [distributorId, retailerId, REMIND_EVERY_HOURS]);
  if (recent) return false;
  await exec(pool, 'INSERT INTO collection_reminders (distributor_id, retailer_id, amount_paise, source) VALUES (?,?,?,?)', [distributorId, retailerId, amountPaise, source]);
  notifyUsers([retailerId], overdue ? 'Payment overdue' : 'Payment reminder', `${businessName}: ₹${fromPaise(amountPaise)} is due. Open AAYME to pay.`, { type: 'khata', id: distributorId });
  return true;
}

collectionsRouter.post('/remind/:retailerId', asyncHandler(async (req, res) => {
  const retailerId = idParam(req, 'retailerId');
  const d = req.auth!.userId;
  const rel = await q1<any>(pool, "SELECT balance_due_paise FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active'", [retailerId, d]);
  if (!rel) throw notFound('Retailer');
  const due = Number(rel.balance_due_paise);
  if (due <= 0) throw new AppError(409, 'NOTHING_DUE', 'This retailer owes nothing');
  await assertPermission(pool, d, 'khatabook_enabled');
  const name = (await q1<any>(pool, 'SELECT business_name FROM distributor_profiles WHERE user_id = ?', [d]))!.business_name;
  const sent = await sendReminder(d, name, retailerId, due, 'manual');
  if (!sent) throw new AppError(429, 'ALREADY_REMINDED', 'A reminder was already sent in the last 24 hours');
  await audit(d, 'collections.remind', 'user', retailerId, { amount_paise: due });
  res.json({ sent: true });
}));

// ---------------------------------------------------------------------------------------------
// Reconciliation: do the payments we were told about and the khata agree?
// ---------------------------------------------------------------------------------------------
export async function reconcile(distributorId: number | null, days = 30) {
  const since = new Date(Date.now() - days * 86400_000);
  const dI = distributorId == null ? '' : ' AND p.distributor_id = ?';
  const dL = distributorId == null ? '' : ' AND l.distributor_id = ?';
  const a = (...x: unknown[]) => (distributorId == null ? x : [...x, distributorId]);
  const match = "l.type = 'payment_online' AND l.distributor_id = p.distributor_id AND l.retailer_id = p.retailer_id AND l.idempotency_key IN (CONCAT('pay:', p.id), CONCAT('gwpay:', p.id))";

  const missing = await q<any>(pool, `SELECT p.id, p.distributor_id, p.retailer_id, p.amount_paise, p.utr, p.method, p.created_at FROM payment_intents p
    WHERE p.status = 'confirmed' AND p.created_at > ?${dI} AND NOT EXISTS (SELECT 1 FROM ledger_transactions l WHERE ${match}) ORDER BY p.id DESC LIMIT 200`, a(since));
  const mismatched = await q<any>(pool, `SELECT p.id, p.distributor_id, p.retailer_id, p.amount_paise intent_paise, l.amount_paise ledger_paise, p.utr FROM payment_intents p
    JOIN ledger_transactions l ON ${match} WHERE p.created_at > ?${dI} AND l.amount_paise <> p.amount_paise LIMIT 200`, a(since));
  const orphans = await q<any>(pool, `SELECT l.id, l.distributor_id, l.retailer_id, l.amount_paise, l.created_at, l.notes FROM ledger_transactions l
    WHERE l.type = 'payment_online' AND l.created_at > ? AND l.gateway_event_id IS NULL AND l.idempotency_key NOT LIKE 'pay:%' AND l.idempotency_key NOT LIKE 'gwpay:%'${dL} ORDER BY l.id DESC LIMIT 200`, a(since));
  const stale = await q<any>(pool, `SELECT p.id, p.distributor_id, p.retailer_id, p.amount_paise, p.utr, p.method, p.created_at FROM payment_intents p
    WHERE p.status = 'pending' AND p.created_at < ? AND p.created_at > ?${dI} ORDER BY p.id LIMIT 200`, a(new Date(Date.now() - 48 * 3600_000), since));
  const failedGw = await q<any>(pool, `SELECT p.id, p.distributor_id, p.retailer_id, p.amount_paise, p.utr, p.created_at FROM payment_intents p
    WHERE p.status = 'failed' AND p.method = 'gateway' AND p.gateway_payment_id IS NOT NULL AND p.created_at > ?${dI} ORDER BY p.id DESC LIMIT 200`, a(since));   // paid, but the wrong amount: money may have moved
  const t1 = await q1<any>(pool, `SELECT COALESCE(SUM(p.amount_paise),0) n FROM payment_intents p WHERE p.status = 'confirmed' AND p.created_at > ?${dI}`, a(since));
  const t2 = await q1<any>(pool, `SELECT COALESCE(SUM(l.amount_paise),0) n FROM ledger_transactions l WHERE l.type = 'payment_online' AND l.created_at > ?${dL}`, a(since));
  const m = (r: any) => ({ ...r, amount: r.amount_paise == null ? undefined : fromPaise(Number(r.amount_paise)), amount_paise: undefined });
  const issues = missing.length + mismatched.length + orphans.length + failedGw.length;
  return {
    days, ok: issues === 0,
    totals: { confirmed_payments: fromPaise(Number(t1!.n)), online_in_khata: fromPaise(Number(t2!.n)), difference: fromPaise(Number(t1!.n) - Number(t2!.n)) },
    confirmed_without_khata_entry: missing.map(m),
    amount_mismatch: mismatched.map((r) => ({ id: r.id, retailer_id: r.retailer_id, utr: r.utr, intent_amount: fromPaise(Number(r.intent_paise)), khata_amount: fromPaise(Number(r.ledger_paise)) })),
    khata_entries_without_payment: orphans.map(m),
    gateway_paid_wrong_amount: failedGw.map(m),
    pending_over_48h: stale.map(m),
  };
}

collectionsRouter.get('/reconciliation', asyncHandler(async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
  res.json(await reconcile(req.auth!.userId, days));
}));
