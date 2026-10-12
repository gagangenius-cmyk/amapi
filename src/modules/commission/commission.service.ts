import { Conn, exec, pool, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';

/**
 * COMMISSION RULES
 *
 * A distributor owes the platform commission on orders retailers place with them outside the retailer's own hierarchy
 * (see orders.is_out_of_hierarchy). For each order line the rate is the most specific active rule that matches:
 *   score = 4 if the rule names the product, else 2 if it names the category, else 0
 *         + 1 if the rule is for this distributor only (rather than every distributor)
 * highest score wins, then the higher priority, then the lower rule id. A rule only counts inside its date window.
 * With no matching rule, the distributor's own rate (distributor_profiles.commission_rate_bps) applies.
 *
 * Amount: a percent rule is basis points of the line value EXCLUDING GST (GST is the government's, not revenue);
 * a fixed_unit rule is paise per unit. Resolved when the order is placed and stored on the order line, earned when the
 * order is delivered, reversed in proportion when a return is approved.
 */
export interface RuleRow { id: number; distributor_id: number | null; category_id: number | null; product_id: number | null; mode: 'percent' | 'fixed_unit'; value: number; priority: number }
export interface Snapshot { mode: 'percent' | 'fixed_unit'; value: number; rule_id: number | null }

export const ruleScore = (r: Pick<RuleRow, 'distributor_id' | 'category_id' | 'product_id'>) => (r.product_id ? 4 : r.category_id ? 2 : 0) + (r.distributor_id ? 1 : 0);

export function pickRule(rules: RuleRow[], o: { distributorId: number; productId: number; categoryId: number | null }): RuleRow | null {
  const match = rules.filter((r) =>
    (r.distributor_id === null || r.distributor_id === o.distributorId) &&
    (r.product_id === null || r.product_id === o.productId) &&
    (r.category_id === null || (o.categoryId !== null && r.category_id === o.categoryId)));
  match.sort((a, b) => ruleScore(b) - ruleScore(a) || b.priority - a.priority || a.id - b.id);
  return match[0] ?? null;
}

export async function activeRules(c: Conn, distributorId: number, onDate = new Date().toISOString().slice(0, 10)): Promise<RuleRow[]> {
  return q<RuleRow>(c, `SELECT id, distributor_id, category_id, product_id, mode, value, priority FROM commission_rules
    WHERE is_active = 1 AND (distributor_id IS NULL OR distributor_id = ?) AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)`, [distributorId, onDate, onDate]);
}

/** What to snapshot on each line of a new out-of-hierarchy order. */
export async function snapshotFor(c: Conn, distributorId: number, fallbackBps: number, products: { id: number; category_id: number | null }[]): Promise<Map<number, Snapshot>> {
  const rules = await activeRules(c, distributorId);
  const out = new Map<number, Snapshot>();
  for (const p of products) {
    const r = pickRule(rules, { distributorId, productId: p.id, categoryId: p.category_id ?? null });
    out.set(p.id, r ? { mode: r.mode, value: r.value, rule_id: r.id } : { mode: 'percent', value: fallbackBps, rule_id: null });
  }
  return out;
}

export const amountFor = (mode: 'percent' | 'fixed_unit', value: number, unitPaise: number, qty: number) =>
  mode === 'percent' ? Math.round((unitPaise * qty * value) / 10000) : value * qty;

// ---------------------------------------------------------------------------------------------
// Earning and reversing (run inside the order / return transaction)
// ---------------------------------------------------------------------------------------------
async function addEntry(c: Conn, e: { distributorId: number; orderId: number; orderItemId?: number | null; returnItemId?: number | null; kind: 'earned' | 'reversal' | 'legacy';
  dedupe: string; basis: number; mode: 'percent' | 'fixed_unit'; value: number; ruleId?: number | null; amount: number }) {
  await exec(c, `INSERT IGNORE INTO commission_entries (distributor_id, order_id, order_item_id, return_item_id, kind, dedupe_key, basis_paise, mode, value, rule_id, amount_paise, occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP())`, [e.distributorId, e.orderId, e.orderItemId ?? null, e.returnItemId ?? null, e.kind, e.dedupe, e.basis, e.mode, e.value, e.ruleId ?? null, e.amount]);
}

/** The order was delivered: earn commission on every shipped line. Safe to call twice (a retry makes no second entry). */
export async function earnCommission(c: Conn, orderId: number) {
  const o = await q1<any>(c, 'SELECT id, distributor_id, is_out_of_hierarchy, commission_rate_bps, total_paise FROM orders WHERE id = ?', [orderId]);
  if (!o || !o.is_out_of_hierarchy) return;
  const items = await q<any>(c, 'SELECT * FROM order_items WHERE order_id = ? AND qty > 0', [orderId]);
  for (const i of items) {
    const mode = (i.commission_mode ?? 'percent') as 'percent' | 'fixed_unit';
    const value = i.commission_value ?? o.commission_rate_bps;     // orders placed before rules existed carry only the order rate
    const amount = amountFor(mode, Number(value), Number(i.unit_price_paise), i.qty);
    if (amount === 0) continue;
    await addEntry(c, { distributorId: o.distributor_id, orderId, orderItemId: i.id, kind: 'earned', dedupe: `e:${i.id}`, basis: Number(i.unit_price_paise) * i.qty, mode, value: Number(value), ruleId: i.commission_rule_id, amount });
  }
}

/** A return was approved: take back the commission on the units that came back. Safe to call twice. */
export async function reverseCommission(c: Conn, returnId: number) {
  const r = await q1<any>(c, 'SELECT id, order_id, distributor_id FROM order_returns WHERE id = ?', [returnId]);
  if (!r) return;
  const o = await q1<any>(c, 'SELECT is_out_of_hierarchy, commission_rate_bps FROM orders WHERE id = ?', [r.order_id]);
  if (!o?.is_out_of_hierarchy) return;
  const items = await q<any>(c, 'SELECT * FROM order_return_items WHERE return_id = ?', [returnId]);
  for (const ri of items) {
    const line = await q1<any>(c, 'SELECT * FROM order_items WHERE order_id = ? AND product_id = ?', [r.order_id, ri.product_id]);
    const mode = (line?.commission_mode ?? 'percent') as 'percent' | 'fixed_unit';
    const value = Number(line?.commission_value ?? o.commission_rate_bps);
    const amount = amountFor(mode, value, Number(ri.unit_price_paise), ri.qty);
    if (amount === 0) continue;
    await addEntry(c, { distributorId: r.distributor_id, orderId: r.order_id, orderItemId: line?.id ?? null, returnItemId: ri.id, kind: 'reversal', dedupe: `r:${ri.id}`,
      basis: Number(ri.unit_price_paise) * ri.qty, mode, value, ruleId: line?.commission_rule_id ?? null, amount: -amount });
  }
}

// ---------------------------------------------------------------------------------------------
// Settlement batches
// ---------------------------------------------------------------------------------------------
export async function dualControl(c: Conn = pool): Promise<boolean> {
  return (await q1<{ value: string }>(c, "SELECT value FROM platform_settings WHERE name = 'settlement_dual_control'"))?.value === '1';
}

/**
 * Claim a distributor's unsettled entries in a period into a new draft batch. Entries are claimed with a conditional update, so
 * two requests (or a retry) can never put the same entry in two batches. The net must be positive: a period where returns
 * outweigh earnings carries forward instead of creating a negative invoice.
 */
export async function createSettlement(c: Conn, o: { distributorId: number; from: string; to: string; createdBy: number }) {
  const overlap = await q1<any>(c, "SELECT id FROM commission_settlements WHERE distributor_id = ? AND status <> 'cancelled' AND period_from <= ? AND period_to >= ? FOR UPDATE", [o.distributorId, o.to, o.from]);
  if (overlap) throw new AppError(409, 'PERIOD_OVERLAPS', `Settlement #${overlap.id} already covers part of this period`);
  const from = `${o.from} 00:00:00`; const to = `${o.to} 23:59:59`;
  const r = await exec(c, "INSERT INTO commission_settlements (distributor_id, period_from, period_to, entry_count, amount_paise, created_by) VALUES (?,?,?,0,0,?)", [o.distributorId, o.from, o.to, o.createdBy]);
  const claimed = await exec(c, 'UPDATE commission_entries SET settlement_id = ? WHERE distributor_id = ? AND settlement_id IS NULL AND occurred_at BETWEEN ? AND ?', [r.insertId, o.distributorId, from, to]);
  const sum = (await q1<any>(c, 'SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) t FROM commission_entries WHERE settlement_id = ?', [r.insertId]))!;
  if (!claimed.affectedRows || Number(sum.t) <= 0) {
    throw new AppError(409, 'NOTHING_DUE', claimed.affectedRows ? `The net for this period is ${(Number(sum.t) / 100).toFixed(2)}, so there is nothing to collect. It carries forward.` : 'There is no unsettled commission in this period');
  }
  await exec(c, 'UPDATE commission_settlements SET entry_count = ?, amount_paise = ? WHERE id = ?', [Number(sum.n), Number(sum.t), r.insertId]);
  return r.insertId as number;
}

export async function releaseEntries(c: Conn, settlementId: number) {
  await exec(c, 'UPDATE commission_entries SET settlement_id = NULL WHERE settlement_id = ?', [settlementId]);
}
