import { Conn, exec, pool, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';
import { fromPaise } from '../../utils/money';
import { changeStock } from '../catalog/stock';

/**
 * Quantities, as the brief names them:
 *   on_hand   sellable units in the warehouses (products.stock_qty, the sum of inventory_balances)
 *   reserved  units promised to orders still waiting for the distributor (status placed) - derived, so it can never drift
 *   available on_hand - reserved: what can still be promised to a new order ("available to promise")
 *   committed units on accepted orders: already taken out of on_hand, not yet shipped
 *   in_transit units on dispatched / out-for-delivery orders
 *   damaged   units set aside: not for sale, not in on_hand
 */

/**
 * Units reserved by waiting orders, per product.
 * To act on the answer (promise stock to a new order) pass lock = true after locking the product rows: a plain read inside a
 * transaction can show a snapshot older than orders committed while this one waited, and two parallel orders would both pass.
 */
export async function reservedByProduct(c: Conn, productIds: number[], distributorId?: number, lock = false): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!productIds.length) return out;
  const rows = await q<{ product_id: number; n: number }>(c, `SELECT oi.product_id, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'placed' AND oi.product_id IN (?)${distributorId ? ' AND o.distributor_id = ?' : ''} GROUP BY oi.product_id${lock ? ' FOR UPDATE' : ''}`, distributorId ? [productIds, distributorId] : [productIds]);
  for (const r of rows) out.set(r.product_id, Number(r.n));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Positions and valuation
// ---------------------------------------------------------------------------------------------
export interface Position {
  product_id: number; name: string; sku: string | null; unit: string; category: string | null;
  on_hand: number; reserved: number; available: number; committed: number; in_transit: number; damaged: number;
  low_stock_threshold: number; low: boolean;
  price: string; cost: string | null; value_at_cost: string | null; value_at_price: string;
  warehouses: { warehouse_id: number; name: string; qty: number; damaged: number }[];
}

export async function positions(distributorId: number, opts: { q?: string; warehouseId?: number; lowOnly?: boolean; limit?: number; offset?: number } = {}) {
  const where = ['p.distributor_id = ?', 'p.deleted_at IS NULL'];
  const args: unknown[] = [distributorId];
  if (opts.q) { where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`, opts.q); }
  if (opts.lowOnly) where.push('p.stock_qty <= p.low_stock_threshold');
  if (opts.warehouseId) where.push('EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.product_id = p.id AND ib.warehouse_id = ? AND (ib.qty > 0 OR ib.damaged_qty > 0))');
  if (opts.warehouseId) args.push(opts.warehouseId);

  const agg = (status: string) => `(SELECT oi.product_id, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.distributor_id = ? AND o.status ${status} GROUP BY oi.product_id)`;
  const rows = await q<any>(pool, `
    SELECT p.id, p.name, p.sku, p.unit, p.category, p.stock_qty, p.damaged_qty, p.low_stock_threshold, p.price_paise, p.cost_paise,
      COALESCE(r.n,0) reserved, COALESCE(m.n,0) committed, COALESCE(t.n,0) in_transit
    FROM products p
    LEFT JOIN ${agg("= 'placed'")} r ON r.product_id = p.id
    LEFT JOIN ${agg("= 'accepted'")} m ON m.product_id = p.id
    LEFT JOIN ${agg("IN ('dispatched','out_for_delivery')")} t ON t.product_id = p.id
    WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT ? OFFSET ?`, [distributorId, distributorId, distributorId, ...args, opts.limit ?? 100, opts.offset ?? 0]);
  const ids = rows.map((r) => r.id);
  const bal = ids.length ? await q<any>(pool, 'SELECT ib.product_id, ib.warehouse_id, w.name, ib.qty, ib.damaged_qty FROM inventory_balances ib JOIN warehouses w ON w.id = ib.warehouse_id WHERE ib.product_id IN (?) AND (ib.qty <> 0 OR ib.damaged_qty <> 0) ORDER BY w.is_default DESC, w.id', [ids]) : [];

  return rows.map((r): Position => {
    const onHand = Number(r.stock_qty); const reserved = Number(r.reserved);
    const price = Number(r.price_paise); const cost = r.cost_paise == null ? null : Number(r.cost_paise);
    return {
      product_id: r.id, name: r.name, sku: r.sku, unit: r.unit, category: r.category,
      on_hand: onHand, reserved, available: onHand - reserved, committed: Number(r.committed), in_transit: Number(r.in_transit), damaged: Number(r.damaged_qty),
      low_stock_threshold: r.low_stock_threshold, low: onHand <= r.low_stock_threshold,
      price: fromPaise(price), cost: cost == null ? null : fromPaise(cost),
      value_at_cost: cost == null ? null : fromPaise(cost * onHand), value_at_price: fromPaise(price * onHand),
      warehouses: bal.filter((b) => b.product_id === r.id).map((b) => ({ warehouse_id: b.warehouse_id, name: b.name, qty: Number(b.qty), damaged: Number(b.damaged_qty) })),
    };
  });
}

/**
 * Stock valuation. "At cost" counts only products that have a cost price, and says how many do not, so a partial figure is
 * never mistaken for the whole. "At selling price" is the retail value of what is on the shelf.
 */
export async function summary(distributorId: number) {
  const t = (await q1<any>(pool, `SELECT COUNT(*) products, COALESCE(SUM(stock_qty),0) on_hand, COALESCE(SUM(damaged_qty),0) damaged,
      COALESCE(SUM(stock_qty * price_paise),0) at_price,
      COALESCE(SUM(CASE WHEN cost_paise IS NOT NULL THEN stock_qty * cost_paise END),0) at_cost,
      COALESCE(SUM(CASE WHEN cost_paise IS NOT NULL THEN damaged_qty * cost_paise END),0) damaged_at_cost,
      COALESCE(SUM(cost_paise IS NULL AND stock_qty > 0),0) without_cost,
      COALESCE(SUM(stock_qty <= low_stock_threshold),0) low, COALESCE(SUM(stock_qty = 0),0) out_of_stock
    FROM products WHERE distributor_id = ? AND deleted_at IS NULL`, [distributorId]))!;
  const flow = await q<any>(pool, `SELECT o.status, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.distributor_id = ? AND o.status IN ('placed','accepted','dispatched','out_for_delivery') GROUP BY o.status`, [distributorId]);
  const f = Object.fromEntries(flow.map((r) => [r.status, Number(r.n)]));
  const reserved = f.placed ?? 0;
  return {
    products: Number(t.products), on_hand: Number(t.on_hand), reserved, available: Number(t.on_hand) - reserved,
    committed: f.accepted ?? 0, in_transit: (f.dispatched ?? 0) + (f.out_for_delivery ?? 0), damaged: Number(t.damaged),
    low_stock_products: Number(t.low), out_of_stock_products: Number(t.out_of_stock),
    valuation: {
      at_cost: fromPaise(Number(t.at_cost)), at_selling_price: fromPaise(Number(t.at_price)), damaged_at_cost: fromPaise(Number(t.damaged_at_cost)),
      products_without_cost: Number(t.without_cost), complete: Number(t.without_cost) === 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------------------------
export const warehouseKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);

export async function listWarehouses(distributorId: number) {
  const rows = await q<any>(pool, `SELECT w.*, COALESCE(SUM(ib.qty),0) units, COALESCE(SUM(ib.damaged_qty),0) damaged, COUNT(DISTINCT CASE WHEN ib.qty > 0 THEN ib.product_id END) products
    FROM warehouses w LEFT JOIN inventory_balances ib ON ib.warehouse_id = w.id WHERE w.distributor_id = ? GROUP BY w.id ORDER BY w.is_default DESC, w.name`, [distributorId]);
  return rows.map((w) => ({ id: w.id, name: w.name, address: w.address, is_default: !!w.is_default, is_active: !!w.is_active, units: Number(w.units), damaged: Number(w.damaged), products: Number(w.products) }));
}

async function ownedWarehouse(c: Conn, distributorId: number, id: number, activeOnly = true) {
  const w = await q1<any>(c, `SELECT * FROM warehouses WHERE id = ? AND distributor_id = ?${activeOnly ? ' AND is_active = 1' : ''}`, [id, distributorId]);
  if (!w) throw new AppError(404, 'NOT_FOUND', 'Warehouse not found');
  return w;
}

// ---------------------------------------------------------------------------------------------
// Moves inside the books
// ---------------------------------------------------------------------------------------------
/** Move units from one warehouse to another. Total stock does not change; the ledger shows an "out" and an "in". */
export async function transferStock(c: Conn, o: { distributorId: number; productId: number; fromId: number; toId: number; qty: number; actorId: number; note?: string | null }) {
  if (o.fromId === o.toId) throw new AppError(400, 'SAME_WAREHOUSE', 'Choose two different warehouses');
  await ownedWarehouse(c, o.distributorId, o.fromId); await ownedWarehouse(c, o.distributorId, o.toId);
  const p = await q1<any>(c, 'SELECT stock_qty FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL FOR UPDATE', [o.productId, o.distributorId]);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  const from = await q1<any>(c, 'SELECT qty FROM inventory_balances WHERE product_id = ? AND warehouse_id = ? FOR UPDATE', [o.productId, o.fromId]);
  if (!from || from.qty < o.qty) throw new AppError(409, 'NOT_ENOUGH_HERE', `Only ${from?.qty ?? 0} in that warehouse`, { available: from?.qty ?? 0 });
  await exec(c, 'UPDATE inventory_balances SET qty = qty - ? WHERE product_id = ? AND warehouse_id = ?', [o.qty, o.productId, o.fromId]);
  await exec(c, 'INSERT INTO inventory_balances (product_id, warehouse_id, qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)', [o.productId, o.toId, o.qty]);
  const row = (wh: number, delta: number, reason: string) => exec(c, 'INSERT INTO stock_movements (product_id, distributor_id, delta, balance_after, reason, note, actor_id, warehouse_id) VALUES (?,?,?,?,?,?,?,?)',
    [o.productId, o.distributorId, delta, p.stock_qty, reason, o.note ?? null, o.actorId, wh]);
  await row(o.fromId, -o.qty, 'transfer_out');
  await row(o.toId, o.qty, 'transfer_in');
}

async function damagedMovement(c: Conn, o: { productId: number; distributorId: number; delta: number; reason: string; warehouseId: number; actorId: number; note?: string | null }) {
  const r = await exec(c, 'UPDATE products SET damaged_qty = damaged_qty + ? WHERE id = ? AND distributor_id = ? AND damaged_qty + ? >= 0', [o.delta, o.productId, o.distributorId, o.delta]);
  if (!r.affectedRows) throw new AppError(409, 'NOT_ENOUGH_DAMAGED', 'There are not that many damaged units');
  const b = await exec(c, 'UPDATE inventory_balances SET damaged_qty = damaged_qty + ? WHERE product_id = ? AND warehouse_id = ? AND damaged_qty + ? >= 0', [o.delta, o.productId, o.warehouseId, o.delta]);
  if (!b.affectedRows && o.delta > 0) {
    await exec(c, 'INSERT INTO inventory_balances (product_id, warehouse_id, qty, damaged_qty) VALUES (?,?,0,?) ON DUPLICATE KEY UPDATE damaged_qty = damaged_qty + VALUES(damaged_qty)', [o.productId, o.warehouseId, o.delta]);
  } else if (!b.affectedRows) {
    throw new AppError(409, 'NOT_ENOUGH_DAMAGED', 'There are not that many damaged units in that warehouse');
  }
  const bal = (await q1<{ damaged_qty: number }>(c, 'SELECT damaged_qty FROM products WHERE id = ?', [o.productId]))!.damaged_qty;
  await exec(c, "INSERT INTO stock_movements (product_id, distributor_id, delta, balance_after, reason, note, actor_id, warehouse_id, bucket) VALUES (?,?,?,?,?,?,?,?, 'damaged')",
    [o.productId, o.distributorId, o.delta, bal, o.reason, o.note ?? null, o.actorId, o.warehouseId]);
}

/** Set units aside as damaged: they leave sellable stock at once and stop being offered or promised. */
export async function markDamaged(c: Conn, o: { distributorId: number; productId: number; warehouseId: number; qty: number; actorId: number; note?: string | null }) {
  await ownedWarehouse(c, o.distributorId, o.warehouseId);
  await changeStock(c, { productId: o.productId, distributorId: o.distributorId, delta: -o.qty, reason: 'damaged', note: o.note, actorId: o.actorId, warehouseId: o.warehouseId });
  await damagedMovement(c, { ...o, delta: o.qty, reason: 'damaged' });
}
/** Damaged units turned out fine: they go back to sellable stock in the same warehouse. */
export async function recoverDamaged(c: Conn, o: { distributorId: number; productId: number; warehouseId: number; qty: number; actorId: number; note?: string | null }) {
  await ownedWarehouse(c, o.distributorId, o.warehouseId);
  await damagedMovement(c, { ...o, delta: -o.qty, reason: 'damaged_recovered' });
  await changeStock(c, { productId: o.productId, distributorId: o.distributorId, delta: o.qty, reason: 'damaged_recovered', note: o.note, actorId: o.actorId, warehouseId: o.warehouseId });
}
/** Damaged units are thrown away. They leave the books for good (the movement is the record). */
export async function writeOffDamaged(c: Conn, o: { distributorId: number; productId: number; warehouseId: number; qty: number; actorId: number; note?: string | null }) {
  await ownedWarehouse(c, o.distributorId, o.warehouseId);
  await damagedMovement(c, { ...o, delta: -o.qty, reason: 'damaged_writeoff' });
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------
/**
 * Compare the four records that must agree for every product:
 *   products.stock_qty  =  sum of warehouse balances  =  sum of on-hand ledger movements  (and batches must not claim more)
 *   products.damaged_qty = sum of damaged-bucket ledger movements = sum of warehouse damaged balances
 * Products that pre-date the ledger can differ by their opening balance; a stock count (correction) brings them in line.
 */
export async function reconcile(distributorId?: number) {
  const rows = await q<any>(pool, `
    SELECT p.id, p.name, p.distributor_id, p.stock_qty, p.damaged_qty,
      COALESCE((SELECT SUM(ib.qty) FROM inventory_balances ib WHERE ib.product_id = p.id),0) warehouse_qty,
      COALESCE((SELECT SUM(ib.damaged_qty) FROM inventory_balances ib WHERE ib.product_id = p.id),0) warehouse_damaged,
      COALESCE((SELECT SUM(m.delta) FROM stock_movements m WHERE m.product_id = p.id AND m.bucket = 'on_hand'),0) ledger_qty,
      COALESCE((SELECT SUM(m.delta) FROM stock_movements m WHERE m.product_id = p.id AND m.bucket = 'damaged'),0) ledger_damaged,
      COALESCE((SELECT SUM(b.qty_remaining) FROM product_batches b WHERE b.product_id = p.id),0) batch_qty
    FROM products p WHERE p.deleted_at IS NULL${distributorId ? ' AND p.distributor_id = ?' : ''}`, distributorId ? [distributorId] : []);
  const issues: { product_id: number; name: string; distributor_id: number; problems: string[]; stock_qty: number; warehouse_qty: number; ledger_qty: number; batch_qty: number; damaged_qty: number; ledger_damaged: number }[] = [];
  for (const r of rows) {
    const problems: string[] = [];
    const s = Number(r.stock_qty);
    if (Number(r.warehouse_qty) !== s) problems.push(`warehouses hold ${r.warehouse_qty} but stock is ${s}`);
    if (Number(r.ledger_qty) !== s) problems.push(`the movement ledger adds up to ${r.ledger_qty} but stock is ${s}`);
    if (Number(r.batch_qty) > s) problems.push(`batches claim ${r.batch_qty}, more than the ${s} in stock`);
    if (Number(r.damaged_qty) !== Number(r.ledger_damaged)) problems.push(`damaged is ${r.damaged_qty} but its ledger adds up to ${r.ledger_damaged}`);
    if (Number(r.damaged_qty) !== Number(r.warehouse_damaged)) problems.push(`damaged is ${r.damaged_qty} but warehouses hold ${r.warehouse_damaged}`);
    if (problems.length) issues.push({ product_id: r.id, name: r.name, distributor_id: r.distributor_id, problems, stock_qty: s, warehouse_qty: Number(r.warehouse_qty), ledger_qty: Number(r.ledger_qty), batch_qty: Number(r.batch_qty), damaged_qty: Number(r.damaged_qty), ledger_damaged: Number(r.ledger_damaged) });
  }
  return { checked: rows.length, clean: issues.length === 0, issues };
}
