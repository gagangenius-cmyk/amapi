import { Conn, exec, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';
import { trimBatches } from './batches';

export type StockReason = 'initial' | 'manual' | 'import' | 'bulk' | 'order_accepted' | 'order_cancelled' | 'correction' | 'customer_return';

/**
 * Change a product's stock and record the movement. Must run inside a transaction.
 * A negative change that would take stock below zero fails (so two accepts can never oversell).
 */
export async function changeStock(c: Conn, o: {
  productId: number; distributorId: number; delta: number; reason: StockReason;
  orderId?: number | null; note?: string | null; actorId?: number | null;
}): Promise<number> {
  const r = await exec(c, 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND distributor_id = ? AND stock_qty + ? >= 0', [o.delta, o.productId, o.distributorId, o.delta]);
  if (!r.affectedRows) throw new AppError(409, 'OUT_OF_STOCK', `Insufficient stock for product ${o.productId}`);
  const row = await q1<{ stock_qty: number }>(c, 'SELECT stock_qty FROM products WHERE id = ?', [o.productId]);
  const balance = row!.stock_qty;
  if (o.delta < 0) await trimBatches(c, o.productId, balance);
  if (o.delta !== 0) {
    await exec(c, 'INSERT INTO stock_movements (product_id, distributor_id, delta, balance_after, reason, ref_order_id, note, actor_id) VALUES (?,?,?,?,?,?,?,?)', [
      o.productId, o.distributorId, o.delta, balance, o.reason, o.orderId ?? null, o.note ?? null, o.actorId ?? null,
    ]);
  }
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
