import { Router } from 'express';
import { z } from 'zod';
import { pool, q, q1 } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { asyncHandler } from '../../utils/errors';
import { fromPaise } from '../../utils/money';

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireRole('distributor'));

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

// Business snapshot for a date range (defaults to the last 30 days).
reportsRouter.get('/summary', asyncHandler(async (req, res) => {
  const qs = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(req.query);
  const d = req.auth!.userId;
  const to = qs.to ? `${qs.to} 23:59:59` : sqlTime(new Date());
  const from = qs.from ? `${qs.from} 00:00:00` : sqlTime(new Date(Date.now() - 30 * 86400000));

  const byStatus = await q<any>(pool, 'SELECT status, COUNT(*) n, COALESCE(SUM(total_paise),0) t FROM orders WHERE distributor_id = ? AND created_at BETWEEN ? AND ? GROUP BY status', [d, from, to]);
  const money = await q1<any>(pool, `
    SELECT COALESCE(SUM(CASE WHEN type='invoice' THEN amount_paise END),0) invoiced,
           COALESCE(SUM(CASE WHEN type IN ('payment_cash','payment_online') THEN amount_paise END),0) collected,
           COALESCE(SUM(CASE WHEN type='payment_cash' THEN amount_paise END),0) cash,
           COALESCE(SUM(CASE WHEN type='payment_online' THEN amount_paise END),0) online
    FROM ledger_transactions WHERE distributor_id = ? AND created_at BETWEEN ? AND ?`, [d, from, to]);
  const out = await q1<any>(pool, 'SELECT COALESCE(SUM(GREATEST(balance_due_paise,0)),0) due FROM retailer_distributor_relations WHERE distributor_id = ?', [d]);
  const top = await q<any>(pool, `
    SELECT rp.shop_name, rdr.balance_due_paise FROM retailer_distributor_relations rdr JOIN retailer_profiles rp ON rp.user_id = rdr.retailer_id
    WHERE rdr.distributor_id = ? AND rdr.balance_due_paise > 0 ORDER BY rdr.balance_due_paise DESC LIMIT 5`, [d]);

  res.json({
    from, to,
    orders: Object.fromEntries(byStatus.map((r) => [r.status, { count: Number(r.n), total: fromPaise(Number(r.t)) }])),
    invoiced: fromPaise(Number(money.invoiced)), collected: fromPaise(Number(money.collected)),
    collected_cash: fromPaise(Number(money.cash)), collected_online: fromPaise(Number(money.online)),
    outstanding: fromPaise(Number(out.due)),
    top_debtors: top.map((t) => ({ shop_name: t.shop_name, due: fromPaise(Number(t.balance_due_paise)) })),
  });
}));
