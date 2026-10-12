import { Conn, exec, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';
import { trimBatches } from './batches';

export type StockReason = 'initial' | 'manual' | 'import' | 'bulk' | 'order_accepted' | 'order_cancelled' | 'correction' | 'customer_return'
  | 'transfer_out' | 'transfer_in' | 'damaged' | 'damaged_recovered' | 'damaged_writeoff';

/** The warehouse new stock goes to when none is named. Created on first use, so every distributor always has one. */
export async function defaultWarehouse(c: Conn, distributorId: number): Promise<number> {
  const find = () => q1<{ id: number }>(c, 'SELECT id FROM warehouses WHERE distributor_id = ? AND is_default = 1 AND is_active = 1 ORDER BY id LIMIT 1', [distributorId]);
  let w = await find();
  if (!w) {
    // no default (new distributor, or the default was switched off): promote an active one, else open "Main warehouse"
    const any = await q1<{ id: number }>(c, 'SELECT id FROM warehouses WHERE distributor_id = ? AND is_active = 1 ORDER BY id LIMIT 1', [distributorId]);
    if (any) { await exec(c, 'UPDATE warehouses SET is_default = 1 WHERE id = ?', [any.id]); return any.id; }
    await exec(c, "INSERT IGNORE INTO warehouses (distributor_id, name, name_key, is_default) VALUES (?, 'Main warehouse', 'main warehouse', 1)", [distributorId]);
    await exec(c, "UPDATE warehouses SET is_default = 1, is_active = 1 WHERE distributor_id = ? AND name_key = 'main warehouse'", [distributorId]);
    w = await find();
  }
  return w!.id;
}

/**
 * Change a product's sellable stock and record the movement(s). Must run inside a transaction.
 *
 * Stock lives in warehouses (inventory_balances) and products.stock_qty is always their sum. A positive change goes to the
 * named warehouse (default: the distributor's default one). A negative change comes from the named warehouse, or, when none
 * is named, from warehouses in order (default first). A change that would take stock below zero fails, so two accepts can
 * never oversell. One ledger row is written per warehouse touched.
 */
export async function changeStock(c: Conn, o: {
  productId: number; distributorId: number; delta: number; reason: StockReason;
  orderId?: number | null; note?: string | null; actorId?: number | null; warehouseId?: number | null;
}): Promise<number> {
  const cur = await q1<{ stock_qty: number }>(c, 'SELECT stock_qty FROM products WHERE id = ? AND distributor_id = ? FOR UPDATE', [o.productId, o.distributorId]);
  if (!cur || cur.stock_qty + o.delta < 0) throw new AppError(409, 'OUT_OF_STOCK', `Insufficient stock for product ${o.productId}`);
  if (o.delta === 0) return cur.stock_qty;

  const dflt = await defaultWarehouse(c, o.distributorId);

  // A counted correction states what is really on the shelf. If the ledger had drifted from the stock figure (a product that
  // pre-dates the ledger, or an outside edit), first write the difference into the ledger, so the count leaves the books straight.
  if (o.reason === 'correction') {
    const led = await q1<{ s: number }>(c, "SELECT COALESCE(SUM(delta),0) s FROM stock_movements WHERE product_id = ? AND bucket = 'on_hand'", [o.productId]);
    const gap = cur.stock_qty - Number(led!.s);
    if (gap !== 0) {
      await exec(c, "INSERT INTO stock_movements (product_id, distributor_id, delta, balance_after, reason, note, actor_id, warehouse_id) VALUES (?,?,?,?, 'correction', 'Earlier stock brought into the ledger', ?, ?)",
        [o.productId, o.distributorId, gap, cur.stock_qty, o.actorId ?? null, dflt]);
    }
  }

  if (o.warehouseId) {
    const w = await q1(c, 'SELECT 1 FROM warehouses WHERE id = ? AND distributor_id = ? AND is_active = 1', [o.warehouseId, o.distributorId]);
    if (!w) throw new AppError(400, 'BAD_WAREHOUSE', 'Unknown or inactive warehouse');
  }

  // Heal a drifted record before using it: balances must add up to the product's stock, or the split below would be wrong.
  const balances = await q<{ warehouse_id: number; qty: number }>(c,
    'SELECT ib.warehouse_id, ib.qty FROM inventory_balances ib JOIN warehouses w ON w.id = ib.warehouse_id WHERE ib.product_id = ? ORDER BY (w.id = ?) DESC, w.is_default DESC, w.id FOR UPDATE', [o.productId, dflt]);
  const sum = balances.reduce((n, b) => n + b.qty, 0);
  if (sum !== cur.stock_qty) {
    await exec(c, 'INSERT INTO inventory_balances (product_id, warehouse_id, qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty = qty + ?', [o.productId, dflt, cur.stock_qty - sum, cur.stock_qty - sum]);
    const d = balances.find((b) => b.warehouse_id === dflt);
    if (d) d.qty += cur.stock_qty - sum; else balances.unshift({ warehouse_id: dflt, qty: cur.stock_qty - sum });
  }

  // which warehouses move, and by how much
  const plan: { warehouseId: number; delta: number }[] = [];
  if (o.delta > 0) {
    plan.push({ warehouseId: o.warehouseId ?? dflt, delta: o.delta });
  } else {
    let need = -o.delta;
    const pool_ = o.warehouseId ? balances.filter((b) => b.warehouse_id === o.warehouseId) : balances;
    for (const b of pool_) {
      if (!need) break;
      const take = Math.min(need, Math.max(0, b.qty));
      if (take > 0) { plan.push({ warehouseId: b.warehouse_id, delta: -take }); need -= take; }
    }
    if (need > 0) throw new AppError(409, 'OUT_OF_STOCK', o.warehouseId ? `Not enough stock of product ${o.productId} in that warehouse` : `Insufficient stock for product ${o.productId}`);
  }

  let balance = cur.stock_qty;
  for (const step of plan) {
    await exec(c, 'INSERT INTO inventory_balances (product_id, warehouse_id, qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)', [o.productId, step.warehouseId, step.delta]);
    balance += step.delta;
    await exec(c, 'INSERT INTO stock_movements (product_id, distributor_id, delta, balance_after, reason, ref_order_id, note, actor_id, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?)', [
      o.productId, o.distributorId, step.delta, balance, o.reason, o.orderId ?? null, o.note ?? null, o.actorId ?? null, step.warehouseId,
    ]);
  }
  await exec(c, 'UPDATE products SET stock_qty = ? WHERE id = ?', [balance, o.productId]);
  if (o.delta < 0) await trimBatches(c, o.productId, balance);
  return balance;
}

export interface Tier { min_qty: number; price_paise: number }

/** Unit price for a quantity: the tier with the largest min_qty not above qty, else the base price. */
export function priceForQty(basePaise: number, tiers: Tier[], qty: number): number {
  let best: Tier | undefined;
  for (const t of tiers) if (t.min_qty <= qty && (!best || t.min_qty > best.min_qty)) best = t;
  return best ? Number(best.price_paise) : basePaise;
}

export async function loadTiers(c: Conn, productIds: number[]): Promise<Map<number, Tier[]>> {
  const map = new Map<number, Tier[]>();
  if (!productIds.length) return map;
  const rows = await q<any>(c, 'SELECT product_id, min_qty, price_paise FROM product_price_tiers WHERE product_id IN (?) ORDER BY min_qty', [productIds]);
  for (const r of rows) {
    const list = map.get(r.product_id) ?? [];
    list.push({ min_qty: r.min_qty, price_paise: Number(r.price_paise) });
    map.set(r.product_id, list);
  }
  return map;
}
