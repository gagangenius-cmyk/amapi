import { Conn, exec, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);
const dateStr = (d: unknown) => (d instanceof Date ? todayUtc(d) : String(d).slice(0, 10));

/**
 * Take `qty` units for an order from batches, earliest expiry first (FEFO). Expired batches are never used.
 * Stock that sits in no batch ("untracked") covers whatever the batches can not. MUST run before the stock count is lowered.
 */
export async function allocateFefo(c: Conn, o: { productId: number; orderId: number; qty: number; today?: string }) {
  const today = o.today ?? todayUtc();
  const p = await q1<any>(c, 'SELECT stock_qty FROM products WHERE id = ?', [o.productId]);
  const batches = await q<any>(c, 'SELECT * FROM product_batches WHERE product_id = ? AND qty_remaining > 0 ORDER BY expiry_date IS NULL, expiry_date, id FOR UPDATE', [o.productId]);
  if (!batches.length) return; // this product does not use batches
  const tracked = batches.reduce((s, b) => s + b.qty_remaining, 0);
  const untracked = Math.max(0, p.stock_qty - tracked);
  let need = o.qty;
  for (const b of batches) {
    if (!need) break;
    if (b.expiry_date && dateStr(b.expiry_date) < today) continue; // expired: never sold
    const take = Math.min(need, b.qty_remaining);
    await exec(c, 'UPDATE product_batches SET qty_remaining = qty_remaining - ? WHERE id = ?', [take, b.id]);
    await exec(c, 'INSERT INTO batch_allocations (order_id, batch_id, qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)', [o.orderId, b.id, take]);
    need -= take;
  }
  if (need > untracked) throw new AppError(409, 'EXPIRED_STOCK', 'Not enough unexpired stock for this product. Write off the expired batch or add fresh stock.', { short_by: need - untracked });
}

/** Put an order's goods back into the batches they came from (cancellation). */
export async function releaseAllocations(c: Conn, orderId: number) {
  const rows = await q<any>(c, 'SELECT batch_id, qty FROM batch_allocations WHERE order_id = ?', [orderId]);
  for (const r of rows) await exec(c, 'UPDATE product_batches SET qty_remaining = qty_remaining + ? WHERE id = ?', [r.qty, r.batch_id]);
  if (rows.length) await exec(c, 'DELETE FROM batch_allocations WHERE order_id = ?', [orderId]);
}

/** If stock was lowered by hand below what the batches claim, shrink the batches that expire LAST so the books stay consistent. */
export async function trimBatches(c: Conn, productId: number, stockNow: number) {
  const batches = await q<any>(c, 'SELECT id, qty_remaining FROM product_batches WHERE product_id = ? AND qty_remaining > 0 ORDER BY expiry_date IS NULL DESC, expiry_date DESC, id DESC', [productId]);
  let excess = batches.reduce((s, b) => s + b.qty_remaining, 0) - stockNow;
  for (const b of batches) {
    if (excess <= 0) break;
    const cut = Math.min(excess, b.qty_remaining);
    await exec(c, 'UPDATE product_batches SET qty_remaining = qty_remaining - ? WHERE id = ?', [cut, b.id]);
    excess -= cut;
  }
}
