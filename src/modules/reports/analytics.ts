import { z } from 'zod';
import { pool, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';
import { fromPaise } from '../../utils/money';

/**
 * Every KPI the admin sees is defined here once, and computed by exactly one query below. All dates are UTC calendar days
 * (the database stores UTC). Order totals already include GST, and the system has no discounts: a price tier simply sets the
 * unit price, so "discount" never needs subtracting. Rejected and cancelled orders never count as sales.
 */
export const KPI_DEFINITIONS = [
  { key: 'gmv', label: 'Gross merchandise value', unit: 'money', definition: 'Total value, GST included, of orders PLACED in the period that were not rejected or cancelled. Includes orders still in progress.' },
  { key: 'gross_sales', label: 'Gross sales (delivered)', unit: 'money', definition: 'Total value, GST included, of orders DELIVERED in the period (by the date of the delivered event, not the date placed).' },
  { key: 'tax_collected', label: 'GST on delivered orders', unit: 'money', definition: 'GST portion of the orders delivered in the period: line totals minus unit price x quantity.' },
  { key: 'returns', label: 'Returns (credit notes)', unit: 'money', definition: 'Value, GST included, of return requests APPROVED in the period.' },
  { key: 'net_sales', label: 'Net sales', unit: 'money', definition: 'Delivered orders excluding GST, minus approved returns excluding GST. Cancelled and rejected orders are never included.' },
  { key: 'platform_revenue', label: 'Platform revenue', unit: 'money', definition: 'Subscription payments CONFIRMED in the period plus commission earned in the period (on delivered out-of-hierarchy orders, excluding GST), net of commission reversed by approved returns.' },
  { key: 'gross_profit', label: 'Gross profit', unit: 'money', definition: 'Not available: products carry no cost price, so profit cannot be calculated honestly. Reported as null rather than estimated.' },
  { key: 'total_orders', label: 'Total orders', unit: 'count', definition: 'Orders placed in the period, in any status.' },
  { key: 'pending_orders', label: 'Pending orders', unit: 'count', definition: 'Orders placed in the period that are still waiting for the distributor to accept (status placed).' },
  { key: 'delivered_orders', label: 'Delivered orders', unit: 'count', definition: 'Orders delivered in the period.' },
  { key: 'cancelled_orders', label: 'Cancelled orders', unit: 'count', definition: 'Orders placed in the period that were cancelled or rejected.' },
  { key: 'active_buyers', label: 'Active buyers', unit: 'count', definition: 'Distinct retailers with at least one non-cancelled order placed in the period.' },
  { key: 'active_distributors', label: 'Active distributors', unit: 'count', definition: 'Distinct distributors that received at least one non-cancelled order in the period.' },
  { key: 'subscribed_distributors', label: 'Distributors with a live subscription', unit: 'count', definition: 'Right now (not period based): distributors whose subscription has not ended.' },
  { key: 'total_products', label: 'Total products', unit: 'count', definition: 'Right now: active, non-deleted products.' },
  { key: 'low_stock_products', label: 'Low stock products', unit: 'count', definition: 'Right now: active products whose stock is at or below their own low-stock threshold.' },
  { key: 'pending_payments', label: 'Pending payments', unit: 'money', definition: 'Right now: retailer UPI payments awaiting confirmation plus distributor subscription payments awaiting confirmation.' },
  { key: 'outstanding_credit', label: 'Outstanding credit', unit: 'money', definition: 'Right now: sum of what retailers owe distributors (positive balances only; advances are not netted off).' },
  { key: 'pending_refunds', label: 'Pending refunds', unit: 'money', definition: 'Right now: value of return requests not yet approved or rejected.' },
  { key: 'repeat_purchase_rate', label: 'Repeat purchase rate', unit: 'percent', definition: 'Of retailers who ordered in the period, the share who placed two or more non-cancelled orders in it.' },
  { key: 'avg_fulfilment_hours', label: 'Average fulfilment time', unit: 'hours', definition: 'For orders delivered in the period: average hours from placed to delivered.' },
] as const;

export interface Range { from: string; to: string; fromDate: string; toDate: string; days: number }

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-10-31').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Not a real date');
export const rangeQuery = z.object({
  from: dateOnly.optional(), to: dateOnly.optional(), distributor_id: z.coerce.number().int().positive().optional(),
});

export const MAX_RANGE_DAYS = 366;

export function parseRange(qs: { from?: string; to?: string }, now = new Date()): Range {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const toDate = qs.to ?? day(now);
  const fromDate = qs.from ?? day(new Date(Date.parse(toDate + 'T00:00:00Z') - 29 * 86400000));
  const days = Math.round((Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z')) / 86400000) + 1;
  if (days < 1) throw new AppError(400, 'BAD_RANGE', '"from" must not be after "to"');
  if (days > MAX_RANGE_DAYS) throw new AppError(400, 'RANGE_TOO_LARGE', `Choose at most ${MAX_RANGE_DAYS} days`);
  return { from: `${fromDate} 00:00:00`, to: `${toDate} 23:59:59`, fromDate, toDate, days };
}

const N = (v: unknown) => Number(v ?? 0);
const money = (v: unknown) => fromPaise(Math.round(N(v)));

/** Every calendar day of the range, so a quiet day shows as zero instead of being missing from a chart. */
function eachDay(r: Range): string[] {
  const out: string[] = [];
  for (let t = Date.parse(r.fromDate + 'T00:00:00Z'); t <= Date.parse(r.toDate + 'T00:00:00Z'); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const dayKey = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** First delivered event per order: "delivered in the period" means this timestamp falls inside it. */
const DELIVERED = `(SELECT order_id, MIN(created_at) at FROM order_events WHERE to_status = 'delivered' GROUP BY order_id)`;

export async function computeAnalytics(r: Range, distributorId?: number) {
  const dO = distributorId ? ' AND o.distributor_id = ?' : '';
  const dArgs = distributorId ? [distributorId] : [];

  // ---- orders placed in the period, by status
  const placed = await q<any>(pool, `SELECT o.status, COUNT(*) n, COALESCE(SUM(o.total_paise),0) t FROM orders o WHERE o.created_at BETWEEN ? AND ?${dO} GROUP BY o.status`, [r.from, r.to, ...dArgs]);
  const by = Object.fromEntries(placed.map((p) => [p.status, { n: N(p.n), t: N(p.t) }]));
  const voided = ['rejected', 'cancelled'];
  const gmv = placed.filter((p) => !voided.includes(p.status)).reduce((s, p) => s + N(p.t), 0);

  // ---- delivered in the period
  const del = (await q1<any>(pool, `
    SELECT COUNT(*) n, COALESCE(SUM(o.total_paise),0) gross,
      COALESCE(AVG(TIMESTAMPDIFF(MINUTE, o.created_at, e.at)),0) / 60 avg_hours,
      COALESCE(AVG(TIMESTAMPDIFF(MINUTE, o.created_at, e.at) <= 2880),0) within_48h
    FROM orders o JOIN ${DELIVERED} e ON e.order_id = o.id
    WHERE o.status = 'delivered' AND e.at BETWEEN ? AND ?${dO}`, [r.from, r.to, ...dArgs]))!;
  const items = (await q1<any>(pool, `
    SELECT COALESCE(SUM(oi.unit_price_paise * oi.qty),0) base, COALESCE(SUM(oi.line_total_paise),0) incl
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN ${DELIVERED} e ON e.order_id = o.id
    WHERE o.status = 'delivered' AND e.at BETWEEN ? AND ?${dO}`, [r.from, r.to, ...dArgs]))!;
  const rets = (await q1<any>(pool, `
    SELECT COALESCE(SUM(rt.total_paise),0) incl,
      COALESCE((SELECT SUM(ri.unit_price_paise * ri.qty) FROM order_return_items ri JOIN order_returns r2 ON r2.id = ri.return_id
        WHERE r2.status = 'approved' AND r2.resolved_at BETWEEN ? AND ?${distributorId ? ' AND r2.distributor_id = ?' : ''}),0) base
    FROM order_returns rt WHERE rt.status = 'approved' AND rt.resolved_at BETWEEN ? AND ?${distributorId ? ' AND rt.distributor_id = ?' : ''}`,
    [r.from, r.to, ...dArgs, r.from, r.to, ...dArgs]))!;
  const comm = (await q1<any>(pool, `SELECT COALESCE(SUM(amount_paise),0) t FROM commission_entries WHERE occurred_at BETWEEN ? AND ?${distributorId ? ' AND distributor_id = ?' : ''}`, [r.from, r.to, ...dArgs]))!;
  const subs = (await q1<any>(pool, `SELECT COALESCE(SUM(amount_paise),0) t FROM subscription_payments WHERE status = 'confirmed' AND decided_at BETWEEN ? AND ?${distributorId ? ' AND distributor_id = ?' : ''}`, [r.from, r.to, ...dArgs]))!;

  // ---- people in the period
  const people = (await q1<any>(pool, `SELECT COUNT(DISTINCT o.retailer_id) buyers, COUNT(DISTINCT o.distributor_id) distributors
    FROM orders o WHERE o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')${dO}`, [r.from, r.to, ...dArgs]))!;
  const repeat = (await q1<any>(pool, `SELECT COUNT(*) buyers, COALESCE(SUM(n >= 2),0) repeaters FROM
    (SELECT o.retailer_id, COUNT(*) n FROM orders o WHERE o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')${dO} GROUP BY o.retailer_id) t`, [r.from, r.to, ...dArgs]))!;

  // ---- right now
  const subscribed = (await q1<any>(pool, `SELECT COUNT(*) n FROM distributor_profiles WHERE subscription_ends_at > UTC_TIMESTAMP()${distributorId ? ' AND user_id = ?' : ''}`, dArgs))!;
  const prod = (await q1<any>(pool, `SELECT COUNT(*) total, COALESCE(SUM(stock_qty <= low_stock_threshold),0) low FROM products WHERE deleted_at IS NULL AND is_active = 1${distributorId ? ' AND distributor_id = ?' : ''}`, dArgs))!;
  const pi = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) t FROM payment_intents WHERE status = 'pending'${distributorId ? ' AND distributor_id = ?' : ''}`, dArgs))!;
  const sp = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) t FROM subscription_payments WHERE status = 'pending'${distributorId ? ' AND distributor_id = ?' : ''}`, dArgs))!;
  const due = (await q1<any>(pool, `SELECT COALESCE(SUM(GREATEST(balance_due_paise,0)),0) t FROM retailer_distributor_relations WHERE status = 'active'${distributorId ? ' AND distributor_id = ?' : ''}`, dArgs))!;
  const pr = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(SUM(total_paise),0) t FROM order_returns WHERE status = 'requested'${distributorId ? ' AND distributor_id = ?' : ''}`, dArgs))!;

  const deliveredBase = N(items.base);
  const netSales = deliveredBase - N(rets.base);

  // ---- series
  const daily = await q<any>(pool, `SELECT DATE(o.created_at) day, COUNT(*) orders,
      COALESCE(SUM(CASE WHEN o.status NOT IN ('rejected','cancelled') THEN o.total_paise END),0) gmv
    FROM orders o WHERE o.created_at BETWEEN ? AND ?${dO} GROUP BY DATE(o.created_at)`, [r.from, r.to, ...dArgs]);
  const dailyMap = new Map(daily.map((d) => [dayKey(d.day), d]));
  const coll = await q<any>(pool, `SELECT DATE(created_at) day,
      COALESCE(SUM(CASE WHEN type IN ('payment_cash','payment_online') THEN amount_paise END),0) collected,
      COALESCE(SUM(CASE WHEN type = 'invoice' THEN amount_paise END),0) invoiced
    FROM ledger_transactions WHERE created_at BETWEEN ? AND ?${distributorId ? ' AND distributor_id = ?' : ''} GROUP BY DATE(created_at)`, [r.from, r.to, ...dArgs]);
  const collMap = new Map(coll.map((d) => [dayKey(d.day), d]));
  const acq = distributorId
    ? await q<any>(pool, 'SELECT DATE(created_at) day, COUNT(*) n FROM retailer_distributor_relations WHERE distributor_id = ? AND created_at BETWEEN ? AND ? GROUP BY DATE(created_at)', [distributorId, r.from, r.to])
    : await q<any>(pool, "SELECT DATE(created_at) day, COUNT(*) n FROM users WHERE role = 'retailer' AND created_at BETWEEN ? AND ? GROUP BY DATE(created_at)", [r.from, r.to]);
  const acqMap = new Map(acq.map((d) => [dayKey(d.day), N(d.n)]));
  const days = eachDay(r);

  const categories = await q<any>(pool, `SELECT COALESCE(NULLIF(p.category,''),'Uncategorised') category, SUM(oi.line_total_paise) revenue, SUM(oi.qty) units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
    WHERE o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')${dO} GROUP BY category ORDER BY revenue DESC LIMIT 10`, [r.from, r.to, ...dArgs]);
  const top = await q<any>(pool, `SELECT oi.product_id, MAX(oi.name) name, SUM(oi.qty) units, SUM(oi.line_total_paise) revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')${dO} GROUP BY oi.product_id ORDER BY revenue DESC LIMIT 10`, [r.from, r.to, ...dArgs]);
  const dist = await q<any>(pool, `SELECT o.distributor_id id, dp.business_name, COUNT(*) orders,
      COALESCE(SUM(CASE WHEN o.status NOT IN ('rejected','cancelled') THEN o.total_paise END),0) gmv, COALESCE(SUM(o.status = 'delivered'),0) delivered
    FROM orders o JOIN distributor_profiles dp ON dp.user_id = o.distributor_id WHERE o.created_at BETWEEN ? AND ?${dO}
    GROUP BY o.distributor_id, dp.business_name ORDER BY gmv DESC LIMIT 10`, [r.from, r.to, ...dArgs]);
  const regions = await q<any>(pool, `SELECT LEFT(rp.pincode, 3) region, COUNT(*) orders, COALESCE(SUM(o.total_paise),0) gmv
    FROM orders o JOIN retailer_profiles rp ON rp.user_id = o.retailer_id
    WHERE o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')${dO} GROUP BY region ORDER BY gmv DESC LIMIT 15`, [r.from, r.to, ...dArgs]);

  const repeatBuyers = N(repeat.buyers);
  return {
    range: { from: r.fromDate, to: r.toDate, days: r.days, timezone: 'UTC', distributor_id: distributorId ?? null },
    kpis: {
      gmv: money(gmv), gross_sales: money(del.gross), tax_collected: money(N(items.incl) - deliveredBase), returns: money(rets.incl), net_sales: money(netSales),
      platform_revenue: money(N(subs.t) + N(comm.t)), platform_revenue_parts: { subscriptions: money(subs.t), commission: money(comm.t) },
      gross_profit: null,
      total_orders: placed.reduce((s, p) => s + N(p.n), 0), pending_orders: by.placed?.n ?? 0, delivered_orders: N(del.n),
      cancelled_orders: (by.cancelled?.n ?? 0) + (by.rejected?.n ?? 0),
      active_buyers: N(people.buyers), active_distributors: N(people.distributors), subscribed_distributors: N(subscribed.n),
      total_products: N(prod.total), low_stock_products: N(prod.low),
      pending_payments: money(N(pi.t) + N(sp.t)), pending_payments_count: N(pi.n) + N(sp.n),
      outstanding_credit: money(due.t), pending_refunds: money(pr.t), pending_refunds_count: N(pr.n),
      repeat_purchase_rate: repeatBuyers ? Math.round((N(repeat.repeaters) / repeatBuyers) * 1000) / 10 : null,
      avg_fulfilment_hours: N(del.n) ? Math.round(N(del.avg_hours) * 10) / 10 : null,
      delivered_within_48h_pct: N(del.n) ? Math.round(N(del.within_48h) * 1000) / 10 : null,
    },
    series: {
      revenue_trend: days.map((d) => ({ date: d, orders: N(dailyMap.get(d)?.orders), gmv: money(dailyMap.get(d)?.gmv) })),
      collection_trend: days.map((d) => ({ date: d, collected: money(collMap.get(d)?.collected), invoiced: money(collMap.get(d)?.invoiced) })),
      buyer_acquisition: days.map((d) => ({ date: d, new_buyers: acqMap.get(d) ?? 0 })),
      category_performance: categories.map((c) => ({ category: c.category, revenue: money(c.revenue), units: N(c.units) })),
      top_products: top.map((t) => ({ product_id: t.product_id, name: t.name, units: N(t.units), revenue: money(t.revenue) })),
      distributor_performance: dist.map((d) => ({ distributor_id: d.id, business_name: d.business_name, orders: N(d.orders), delivered: N(d.delivered), gmv: money(d.gmv) })),
      regional_sales: regions.map((g) => ({ region: g.region, orders: N(g.orders), gmv: money(g.gmv) })),
    },
  };
}
