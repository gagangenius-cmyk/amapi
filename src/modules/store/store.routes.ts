import { Router } from 'express';
import { z } from 'zod';
import { Conn, exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { toPaise, withGst } from '../../utils/money';
import { storefrontProducts } from '../catalog/catalog.routes';
import { storeAccess } from '../retailers/access';
import { addStoreCustomer, ensureStore, money, presentOrder, presentProduct, presentStore, storeLive, storeQrText, todayIst } from './store.service';
import { upiUri } from '../subscription/subscription.service';

/*
 * The retailer's own online store, billing counter and books. Everything here is for a signed-in retailer.
 * Reading is always allowed; changing anything needs a live subscription (an active AAYME plan).
 */
export const storeRouter = Router();
storeRouter.use(authenticate, requireRole('retailer'));

async function myStore(req: any) {
  const s = await ensureStore(pool, req.auth.userId);
  if (!s) throw notFound('Shop');
  return s;
}
async function liveStore(req: any) {
  const s = await myStore(req);
  if (!(await storeLive(pool, s))) throw new AppError(402, 'STORE_NOT_ACTIVE', 'Your online store starts once you have an active AAYME subscription. Ask your distributor for a plan.');
  return s;
}
const optText = (n: number) => z.string().trim().max(n).nullable().optional();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time looks like 09:30').nullable().optional();

// ---------------------------------------------------------------------------------------------
// Store profile and settings
// ---------------------------------------------------------------------------------------------
storeRouter.get('/me', asyncHandler(async (req, res) => {
  const s = await myStore(req);
  const live = await storeLive(pool, s);
  res.json({
    store: { ...presentStore(s, { live }), upi_id: s.upi_id, upi_payee: s.upi_payee, open_override: s.open_override, is_active: !!s.is_active },
    live, qr_text: storeQrText(s.code), store_code: s.code,
  });
}));

storeRouter.put('/me', asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(120).optional(), description: optText(500), phone: z.string().regex(/^\d{10}$/).nullable().optional(),
    whatsapp_url: optText(255), facebook_url: optText(255), instagram_url: optText(255), youtube_url: optText(255),
    address: optText(255), pincode: z.string().regex(/^\d{6}$/).nullable().optional(), lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional(),
    opens_at: clock, closes_at: clock, open_override: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
    delivery_enabled: z.boolean().optional(), delivery_fee: z.union([z.string(), z.number()]).optional(), free_delivery_above: z.union([z.string(), z.number()]).nullable().optional(),
    min_order: z.union([z.string(), z.number()]).optional(), delivery_minutes_min: z.number().int().min(0).max(1440).nullable().optional(), delivery_minutes_max: z.number().int().min(0).max(1440).nullable().optional(),
    upi_id: z.string().trim().regex(/^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/, 'UPI id looks like name@bank').nullable().optional(), upi_payee: optText(80),
    accepts_cod: z.boolean().optional(), accepts_upi: z.boolean().optional(), is_active: z.boolean().optional(),
  }).parse(req.body);
  const s = await myStore(req);
  const sets: string[] = []; const args: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };
  for (const k of ['name', 'description', 'phone', 'whatsapp_url', 'facebook_url', 'instagram_url', 'youtube_url', 'address', 'pincode', 'lat', 'lng', 'opens_at', 'closes_at', 'open_override', 'delivery_minutes_min', 'delivery_minutes_max', 'upi_id', 'upi_payee'] as const)
    if ((b as any)[k] !== undefined) put(k, (b as any)[k]);
  if (b.delivery_enabled !== undefined) put('delivery_enabled', b.delivery_enabled ? 1 : 0);
  if (b.accepts_cod !== undefined) put('accepts_cod', b.accepts_cod ? 1 : 0);
  if (b.accepts_upi !== undefined) put('accepts_upi', b.accepts_upi ? 1 : 0);
  if (b.is_active !== undefined) put('is_active', b.is_active ? 1 : 0);
  if (b.delivery_fee !== undefined) put('delivery_fee_paise', toPaise(b.delivery_fee));
  if (b.free_delivery_above !== undefined) put('free_delivery_above_paise', b.free_delivery_above == null ? null : toPaise(b.free_delivery_above));
  if (b.min_order !== undefined) put('min_order_paise', toPaise(b.min_order));
  if (!sets.length) throw new AppError(400, 'NOTHING_TO_CHANGE', 'Nothing to change');
  await exec(pool, `UPDATE retailer_stores SET ${sets.join(', ')} WHERE retailer_id = ?`, [...args, s.retailer_id]);
  const fresh = (await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [s.retailer_id]))!;
  res.json({ store: { ...presentStore(fresh, { live: await storeLive(pool, fresh) }), upi_id: fresh.upi_id, upi_payee: fresh.upi_payee, open_override: fresh.open_override, is_active: !!fresh.is_active } });
}));

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------
storeRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const s = await myStore(req); const r = s.retailer_id;
  const live = await storeLive(pool, s);
  const customers = Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM store_customers WHERE retailer_id = ?', [r]))!.n);
  const fresh = Number((await q1<any>(pool, "SELECT COUNT(*) n FROM store_orders WHERE retailer_id = ? AND channel = 'online' AND status = 'placed'", [r]))!.n);
  const sold = (await q1<any>(pool, `SELECT COALESCE(SUM(total_paise),0) total, COUNT(*) n FROM store_orders WHERE retailer_id = ? AND status NOT IN ('cancelled','rejected') AND (channel = 'counter' OR payment_status = 'paid' OR status = 'delivered')`, [r]))!;
  const earn = (await q1<any>(pool, `SELECT COALESCE(SUM((i.unit_price_paise - i.cost_paise) * i.qty),0) margin FROM store_order_items i JOIN store_orders o ON o.id = i.order_id
    WHERE o.retailer_id = ? AND o.status NOT IN ('cancelled','rejected') AND (o.channel = 'counter' OR o.payment_status = 'paid' OR o.status = 'delivered') AND i.cost_paise IS NOT NULL`, [r]))!;
  const today = (await q1<any>(pool, `SELECT COALESCE(SUM(total_paise),0) total, COUNT(*) n FROM store_orders WHERE retailer_id = ? AND status NOT IN ('cancelled','rejected')
    AND DATE(CONVERT_TZ(created_at,'+00:00','+05:30')) = ?`, [r, todayIst()]))!;
  const products = Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM store_products WHERE retailer_id = ? AND deleted_at IS NULL', [r]))!.n);
  const low = Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM store_products WHERE retailer_id = ? AND deleted_at IS NULL AND is_active = 1 AND stock_qty <= 5', [r]))!.n);
  res.json({ live, store_code: s.code, total_customers: customers, new_orders: fresh, total_sales: money(sold.total), orders_count: Number(sold.n), earnings: money(earn.margin),
    today_sales: money(today.total), today_orders: Number(today.n), products, low_stock: low });
}));

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------
const productBody = z.object({
  name: z.string().trim().min(1).max(190), description: optText(1000), brand: optText(80), category: optText(80), unit: z.string().trim().min(1).max(20).default('pcs'),
  barcode: z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, 'Barcode is 4 to 40 letters, digits or dashes').nullable().optional(), sku: optText(60),
  price: z.union([z.string(), z.number()]), mrp: z.union([z.string(), z.number()]).nullable().optional(), cost: z.union([z.string(), z.number()]).nullable().optional(),
  gst_rate_bps: z.number().int().min(0).max(2800).default(0), stock_qty: z.number().int().min(0).max(10_000_000).default(0), image_url: optText(255), is_active: z.boolean().default(true),
});

storeRouter.get('/products', asyncHandler(async (req, res) => {
  const qs = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'active', 'hidden', 'low', 'out']).default('all'), category: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const where = ['retailer_id = ?', 'deleted_at IS NULL']; const args: unknown[] = [req.auth!.userId];
  if (qs.q) { where.push('(name LIKE ? OR brand LIKE ? OR barcode = ? OR sku LIKE ?)'); args.push(`%${qs.q}%`, `%${qs.q}%`, qs.q, `%${qs.q}%`); }
  if (qs.category) { where.push('category = ?'); args.push(qs.category); }
  if (qs.status === 'active') where.push('is_active = 1'); else if (qs.status === 'hidden') where.push('is_active = 0'); else if (qs.status === 'low') where.push('stock_qty > 0 AND stock_qty <= 5'); else if (qs.status === 'out') where.push('stock_qty <= 0');
  const rows = await q<any>(pool, `SELECT * FROM store_products WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, qs.limit, qs.offset]);
  const cats = await q<any>(pool, 'SELECT DISTINCT category FROM store_products WHERE retailer_id = ? AND deleted_at IS NULL AND category IS NOT NULL ORDER BY category', [req.auth!.userId]);
  res.json({ products: rows.map((p) => ({ ...presentProduct(p), cost: p.cost_paise == null ? null : money(p.cost_paise) })), categories: cats.map((c) => c.category) });
}));

storeRouter.get('/products/by-barcode/:code', asyncHandler(async (req, res) => {
  const p = await q1<any>(pool, 'SELECT * FROM store_products WHERE retailer_id = ? AND barcode = ? AND deleted_at IS NULL AND is_active = 1', [req.auth!.userId, String(req.params.code)]);
  if (!p) throw notFound('Product');
  res.json({ ...presentProduct(p), cost: p.cost_paise == null ? null : money(p.cost_paise) });
}));

storeRouter.post('/products', asyncHandler(async (req, res) => {
  const s = await liveStore(req);
  const b = productBody.parse(req.body);
  const price = toPaise(b.price); const mrp = b.mrp == null || b.mrp === '' ? null : toPaise(b.mrp); const cost = b.cost == null || b.cost === '' ? null : toPaise(b.cost);
  if (price <= 0) throw new AppError(400, 'BAD_PRICE', 'Price must be more than zero');
  if (mrp != null && mrp < price) throw new AppError(400, 'BAD_MRP', 'The M.R.P. cannot be less than the selling price');
  if (b.barcode && (await q1(pool, 'SELECT 1 FROM store_products WHERE retailer_id = ? AND barcode = ? AND deleted_at IS NULL', [s.retailer_id, b.barcode]))) throw new AppError(409, 'BARCODE_TAKEN', 'Another product of yours already uses this barcode');
  const r = await exec(pool, `INSERT INTO store_products (retailer_id, name, description, brand, category, unit, barcode, sku, price_paise, mrp_paise, cost_paise, gst_rate_bps, stock_qty, image_url, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [s.retailer_id, b.name, b.description ?? null, b.brand ?? null, b.category ?? null, b.unit, b.barcode ?? null, b.sku ?? null, price, mrp, cost, b.gst_rate_bps, b.stock_qty, b.image_url ?? null, b.is_active ? 1 : 0]);
  res.status(201).json(presentProduct((await q1<any>(pool, 'SELECT * FROM store_products WHERE id = ?', [r.insertId]))));
}));

storeRouter.put('/products/:id', asyncHandler(async (req, res) => {
  const s = await liveStore(req);
  const b = productBody.partial().parse(req.body); const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM store_products WHERE id = ? AND retailer_id = ? AND deleted_at IS NULL', [id, s.retailer_id]);
  if (!cur) throw notFound('Product');
  const price = b.price === undefined ? Number(cur.price_paise) : toPaise(b.price);
  const mrp = b.mrp === undefined ? cur.mrp_paise : b.mrp == null || b.mrp === '' ? null : toPaise(b.mrp);
  const cost = b.cost === undefined ? cur.cost_paise : b.cost == null || b.cost === '' ? null : toPaise(b.cost);
  if (price <= 0) throw new AppError(400, 'BAD_PRICE', 'Price must be more than zero');
  if (mrp != null && Number(mrp) < price) throw new AppError(400, 'BAD_MRP', 'The M.R.P. cannot be less than the selling price');
  const barcode = b.barcode === undefined ? cur.barcode : b.barcode;
  if (barcode && barcode !== cur.barcode && (await q1(pool, 'SELECT 1 FROM store_products WHERE retailer_id = ? AND barcode = ? AND deleted_at IS NULL AND id <> ?', [s.retailer_id, barcode, id]))) throw new AppError(409, 'BARCODE_TAKEN', 'Another product of yours already uses this barcode');
  const pick = (k: keyof typeof b, old: unknown) => (b[k] === undefined ? old : b[k]);
  await exec(pool, `UPDATE store_products SET name=?, description=?, brand=?, category=?, unit=?, barcode=?, sku=?, price_paise=?, mrp_paise=?, cost_paise=?, gst_rate_bps=?, stock_qty=?, image_url=?, is_active=? WHERE id = ?`, [
    pick('name', cur.name), pick('description', cur.description), pick('brand', cur.brand), pick('category', cur.category), pick('unit', cur.unit), barcode, pick('sku', cur.sku), price, mrp, cost,
    pick('gst_rate_bps', cur.gst_rate_bps), pick('stock_qty', cur.stock_qty), pick('image_url', cur.image_url), b.is_active === undefined ? cur.is_active : b.is_active ? 1 : 0, id]);
  const fresh = (await q1<any>(pool, 'SELECT * FROM store_products WHERE id = ?', [id]))!;
  res.json({ ...presentProduct(fresh), cost: fresh.cost_paise == null ? null : money(fresh.cost_paise) });
}));

storeRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  const r = await exec(pool, 'UPDATE store_products SET deleted_at = UTC_TIMESTAMP(), is_active = 0 WHERE id = ? AND retailer_id = ? AND deleted_at IS NULL', [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Product');
  res.status(204).end();
}));

// The distributor's catalogue, as this retailer sees it (their own rates), so products can be copied into the store.
storeRouter.get('/distributor-products', asyncHandler(async (req, res) => {
  const qs = z.object({ distributor_id: z.coerce.number().int().positive(), q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  if (!(await storeAccess(pool, req.auth!.userId, qs.distributor_id))) throw notFound('Distributor');
  const r = await storefrontProducts(qs.distributor_id, { q: qs.q, category: qs.category, limit: qs.limit, retailerId: req.auth!.userId });
  const mine = new Set((await q<any>(pool, 'SELECT source_product_id FROM store_products WHERE retailer_id = ? AND source_distributor_id = ? AND deleted_at IS NULL', [req.auth!.userId, qs.distributor_id])).map((x) => Number(x.source_product_id)));
  res.json({ products: (r.products as any[]).map((p) => ({ id: p.id, name: p.display_name ?? p.name, brand: p.brand, category: p.category, unit: p.unit, barcode: p.barcode, price: p.price, gst_rate_bps: p.gst_rate_bps, mrp: p.mrp, image_url: p.image_url,
    your_cost: money(withGst(toPaise(p.price), p.gst_rate_bps)), in_stock: Number(p.available_qty ?? p.stock_qty) > 0, already_in_store: mine.has(Number(p.id)) })), categories: r.categories });
}));

// Copy products from a distributor's catalogue into the store. The retailer's cost is what they pay (with GST); the selling price is cost + markup unless a price is given.
storeRouter.post('/products/import', asyncHandler(async (req, res) => {
  const s = await liveStore(req);
  const b = z.object({ distributor_id: z.number().int().positive(), product_ids: z.array(z.number().int().positive()).min(1).max(100), markup_percent: z.number().min(0).max(500).default(10), stock_qty: z.number().int().min(0).default(0) }).parse(req.body);
  if (!(await storeAccess(pool, s.retailer_id, b.distributor_id))) throw notFound('Distributor');
  const all = await storefrontProducts(b.distributor_id, { limit: 200, retailerId: s.retailer_id });
  const byId = new Map<number, any>((all.products as any[]).map((p) => [Number(p.id), p]));
  let added = 0; const skipped: { id: number; reason: string }[] = [];
  for (const id of b.product_ids) {
    const p = byId.get(id);
    if (!p) { skipped.push({ id, reason: 'not available to you' }); continue; }
    if (await q1(pool, 'SELECT 1 FROM store_products WHERE retailer_id = ? AND source_distributor_id = ? AND source_product_id = ? AND deleted_at IS NULL', [s.retailer_id, b.distributor_id, id])) { skipped.push({ id, reason: 'already in your store' }); continue; }
    const cost = withGst(toPaise(p.price), p.gst_rate_bps);
    const price = Math.max(cost, Math.round(cost * (1 + b.markup_percent / 100)));
    const mrp = p.mrp ? Math.max(price, toPaise(p.mrp)) : null;
    await exec(pool, `INSERT INTO store_products (retailer_id, name, brand, category, unit, barcode, price_paise, mrp_paise, cost_paise, gst_rate_bps, stock_qty, image_url, source_distributor_id, source_product_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [s.retailer_id, p.display_name ?? p.name, p.brand ?? null, p.category ?? null, p.unit ?? 'pcs', p.barcode ?? null, price, mrp, cost, p.gst_rate_bps, b.stock_qty, p.image_url ?? null, b.distributor_id, id]);
    added++;
  }
  res.status(201).json({ added, skipped });
}));

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------
storeRouter.get('/customers', asyncHandler(async (req, res) => {
  const { q: text } = z.object({ q: z.string().trim().max(60).optional() }).parse(req.query);
  const where = ['sc.retailer_id = ?']; const args: unknown[] = [req.auth!.userId];
  if (text) { where.push('(sc.name LIKE ? OR sc.phone LIKE ?)'); args.push(`%${text}%`, `%${text}%`); }
  const rows = await q<any>(pool, `SELECT sc.*, (SELECT COUNT(*) FROM store_orders o WHERE o.retailer_id = sc.retailer_id AND o.customer_phone = sc.phone AND o.status NOT IN ('cancelled','rejected')) orders,
      (SELECT COALESCE(SUM(o.total_paise),0) FROM store_orders o WHERE o.retailer_id = sc.retailer_id AND o.customer_phone = sc.phone AND o.status NOT IN ('cancelled','rejected')) spent
    FROM store_customers sc WHERE ${where.join(' AND ')} ORDER BY sc.id DESC LIMIT 300`, args);
  res.json({ customers: rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, source: c.source, has_app: !!c.customer_id, orders: Number(c.orders), spent: money(c.spent), joined: c.created_at })) });
}));
storeRouter.post('/customers', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().regex(/^\d{10}$/, '10-digit phone') }).parse(req.body);
  const s = await liveStore(req);
  const c = await addStoreCustomer(pool, s.retailer_id, { name: b.name, phone: b.phone, source: 'manual' });
  res.status(201).json({ id: c.id, name: c.name, phone: c.phone });
}));

// ---------------------------------------------------------------------------------------------
// Online orders
// ---------------------------------------------------------------------------------------------
const NEXT: Record<string, string[]> = { placed: ['accepted', 'rejected', 'cancelled'], accepted: ['out_for_delivery', 'delivered', 'cancelled'], out_for_delivery: ['delivered', 'cancelled'] };

storeRouter.get('/orders', asyncHandler(async (req, res) => {
  const qs = z.object({ status: z.enum(['placed', 'accepted', 'out_for_delivery', 'delivered', 'cancelled', 'rejected', 'open']).optional(), channel: z.enum(['online', 'counter']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const where = ['o.retailer_id = ?']; const args: unknown[] = [req.auth!.userId];
  if (qs.status === 'open') where.push("o.status IN ('placed','accepted','out_for_delivery')"); else if (qs.status) { where.push('o.status = ?'); args.push(qs.status); }
  if (qs.channel) { where.push('o.channel = ?'); args.push(qs.channel); }
  const rows = await q<any>(pool, `SELECT o.*, (SELECT COUNT(*) FROM store_order_items i WHERE i.order_id = o.id) item_count FROM store_orders o WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...args, qs.limit, qs.offset]);
  res.json({ orders: rows.map((o) => presentOrder(o)) });
}));

storeRouter.get('/orders/:id', asyncHandler(async (req, res) => {
  const o = await q1<any>(pool, 'SELECT * FROM store_orders WHERE id = ? AND retailer_id = ?', [idParam(req), req.auth!.userId]);
  if (!o) throw notFound('Order');
  res.json(presentOrder(o, await q<any>(pool, 'SELECT * FROM store_order_items WHERE order_id = ?', [o.id])));
}));

storeRouter.post('/orders/:id/transition', asyncHandler(async (req, res) => {
  const { to, upi_ref } = z.object({ to: z.enum(['accepted', 'rejected', 'out_for_delivery', 'delivered', 'cancelled']), upi_ref: z.string().trim().max(60).optional() }).parse(req.body);
  const id = idParam(req); const r = req.auth!.userId;
  const out = await withTx(async (c) => {
    const o = await q1<any>(c, "SELECT * FROM store_orders WHERE id = ? AND retailer_id = ? AND channel = 'online' FOR UPDATE", [id, r]);
    if (!o) throw notFound('Order');
    if (!(NEXT[o.status] ?? []).includes(to)) throw new AppError(409, 'BAD_TRANSITION', `An order that is ${o.status.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`);
    // stock goes back when an accepted order is called off
    if (['cancelled', 'rejected'].includes(to)) await restock(c, id);
    // cash on delivery is paid when it is delivered; a UPI order is paid once the retailer sees the money
    const paid = to === 'delivered' && o.payment_method === 'cod';
    await exec(c, `UPDATE store_orders SET status = ?, payment_status = IF(?, 'paid', payment_status), upi_ref = COALESCE(?, upi_ref) WHERE id = ?`, [to, paid ? 1 : 0, upi_ref ?? null, id]);
    return o;
  });
  if (out.customer_id) {
    const text: Record<string, string> = { accepted: 'Your order was accepted', rejected: 'Your order was rejected', out_for_delivery: 'Your order is on its way', delivered: 'Your order was delivered', cancelled: 'Your order was cancelled' };
    notifyUsers([out.customer_id], text[to], `Order #${id}`, { type: 'store_order', id });
  }
  res.json({ status: to });
}));

storeRouter.post('/orders/:id/mark-paid', asyncHandler(async (req, res) => {
  const { upi_ref } = z.object({ upi_ref: z.string().trim().max(60).optional() }).parse(req.body ?? {});
  const r = await exec(pool, "UPDATE store_orders SET payment_status = 'paid', upi_ref = COALESCE(?, upi_ref) WHERE id = ? AND retailer_id = ? AND status NOT IN ('cancelled','rejected')", [upi_ref ?? null, idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Order');
  res.json({ payment_status: 'paid' });
}));

async function restock(c: Conn, orderId: number) {
  const items = await q<any>(c, 'SELECT product_id, qty FROM store_order_items WHERE order_id = ? AND product_id IS NOT NULL', [orderId]);
  for (const i of items) await exec(c, 'UPDATE store_products SET stock_qty = stock_qty + ? WHERE id = ?', [i.qty, i.product_id]);
}

// ---------------------------------------------------------------------------------------------
// Counter billing (scan the items, take the payment, print the bill) and the day book
// ---------------------------------------------------------------------------------------------
const billBody = z.object({
  items: z.array(z.object({ product_id: z.number().int().positive().optional(), barcode: z.string().trim().max(40).optional(), qty: z.number().int().min(1).max(100000), price: z.union([z.string(), z.number()]).optional() })
    .refine((i) => i.product_id || i.barcode, 'Each item needs a product or a barcode')).min(1).max(200),
  payment_mode: z.enum(['cash', 'card', 'upi']), customer_name: z.string().trim().max(120).optional(), customer_phone: z.string().regex(/^\d{10}$/).optional(),
  discount: z.union([z.string(), z.number()]).optional(), note: z.string().trim().max(300).optional(), upi_ref: z.string().trim().max(60).optional(), paid: z.boolean().default(true),
});

storeRouter.post('/pos/bills', asyncHandler(async (req, res) => {
  const b = billBody.parse(req.body);
  const s = await liveStore(req);
  const bill = await withTx(async (c) => {
    // a bill number that never repeats: the counter lives on the store row
    await exec(c, 'UPDATE retailer_stores SET bill_seq = bill_seq + 1 WHERE retailer_id = ?', [s.retailer_id]);
    const seq = Number((await q1<any>(c, 'SELECT bill_seq FROM retailer_stores WHERE retailer_id = ?', [s.retailer_id]))!.bill_seq);
    const lines: { p: any; qty: number; unit: number }[] = [];
    for (const i of b.items) {
      const p = i.product_id ? await q1<any>(c, 'SELECT * FROM store_products WHERE id = ? AND retailer_id = ? AND deleted_at IS NULL FOR UPDATE', [i.product_id, s.retailer_id])
        : await q1<any>(c, 'SELECT * FROM store_products WHERE barcode = ? AND retailer_id = ? AND deleted_at IS NULL FOR UPDATE', [i.barcode, s.retailer_id]);
      if (!p) throw new AppError(404, 'PRODUCT_NOT_FOUND', `No product ${i.barcode ? `with barcode ${i.barcode}` : `#${i.product_id}`} in your store`);
      if (Number(p.stock_qty) < i.qty) throw new AppError(409, 'OUT_OF_STOCK', `${p.name}: only ${p.stock_qty} in stock`);
      lines.push({ p, qty: i.qty, unit: i.price === undefined ? Number(p.price_paise) : toPaise(i.price) });
    }
    const subtotal = lines.reduce((t, l) => t + l.unit * l.qty, 0);
    const discount = b.discount === undefined ? 0 : toPaise(b.discount);
    if (discount < 0 || discount > subtotal) throw new AppError(400, 'BAD_DISCOUNT', 'The discount cannot be more than the bill');
    const total = subtotal - discount;
    const billNo = `B${s.retailer_id}-${String(seq).padStart(5, '0')}`;
    const o = await exec(c, `INSERT INTO store_orders (retailer_id, customer_name, customer_phone, channel, bill_no, bill_seq, status, payment_method, payment_status, subtotal_paise, discount_paise, total_paise, note, upi_ref)
      VALUES (?,?,?,'counter',?,?,'delivered',?,?,?,?,?,?,?)`, [s.retailer_id, b.customer_name ?? null, b.customer_phone ?? null, billNo, seq, b.payment_mode, b.paid ? 'paid' : 'pending', subtotal, discount, total, b.note ?? null, b.upi_ref ?? null]);
    for (const l of lines) {
      await exec(c, 'INSERT INTO store_order_items (order_id, product_id, name, unit, qty, unit_price_paise, cost_paise, line_total_paise) VALUES (?,?,?,?,?,?,?,?)', [o.insertId, l.p.id, l.p.name, l.p.unit, l.qty, l.unit, l.p.cost_paise, l.unit * l.qty]);
      await exec(c, 'UPDATE store_products SET stock_qty = stock_qty - ? WHERE id = ?', [l.qty, l.p.id]);
    }
    if (b.customer_phone) await addStoreCustomer(c, s.retailer_id, { name: b.customer_name ?? 'Customer', phone: b.customer_phone, source: 'counter' });
    return { id: o.insertId as number, total, billNo };
  });
  res.status(201).json(await billOut(bill.id, s));
}));

async function billOut(id: number, s: any) {
  const o = (await q1<any>(pool, 'SELECT * FROM store_orders WHERE id = ?', [id]))!;
  const items = await q<any>(pool, 'SELECT * FROM store_order_items WHERE order_id = ?', [id]);
  const total = Number(o.total_paise);
  const upi = s.upi_id ? upiUri(s.upi_id, s.upi_payee ?? s.name, total, `Bill ${o.bill_no}`) : null;      // the customer scans this and pays straight into the retailer's account
  return {
    ...presentOrder(o, items),
    store: { name: s.name, address: s.address, phone: s.phone, pincode: s.pincode }, upi_link: o.payment_method === 'upi' ? upi : null, upi_qr_text: upi,
  };
}

storeRouter.get('/pos/bills/:id', asyncHandler(async (req, res) => {
  const s = await myStore(req);
  const o = await q1<any>(pool, "SELECT id FROM store_orders WHERE id = ? AND retailer_id = ? AND channel = 'counter'", [idParam(req), s.retailer_id]);
  if (!o) throw notFound('Bill');
  res.json(await billOut(o.id, s));
}));

storeRouter.post('/pos/bills/:id/paid', asyncHandler(async (req, res) => {
  const { upi_ref } = z.object({ upi_ref: z.string().trim().max(60).optional() }).parse(req.body ?? {});
  const r = await exec(pool, "UPDATE store_orders SET payment_status = 'paid', upi_ref = COALESCE(?, upi_ref) WHERE id = ? AND retailer_id = ? AND channel = 'counter'", [upi_ref ?? null, idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Bill');
  res.json({ payment_status: 'paid' });
}));

// A bill made by mistake is cancelled (never deleted): the stock goes back and it drops out of the day's total.
storeRouter.post('/pos/bills/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam(req);
  await withTx(async (c) => {
    const o = await q1<any>(c, "SELECT * FROM store_orders WHERE id = ? AND retailer_id = ? AND channel = 'counter' FOR UPDATE", [id, req.auth!.userId]);
    if (!o) throw notFound('Bill');
    if (o.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', 'This bill is already cancelled');
    await restock(c, id);
    await exec(c, "UPDATE store_orders SET status = 'cancelled' WHERE id = ?", [id]);
  });
  await audit(req.auth!.userId, 'store.bill_cancel', 'store_order', id);
  res.json({ status: 'cancelled' });
}));

// The whole day's account book: sales by how they were paid, online orders, and every bill.
storeRouter.get('/daybook', asyncHandler(async (req, res) => {
  const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIst()) }).parse(req.query);
  const r = req.auth!.userId;
  const day = "DATE(CONVERT_TZ(o.created_at,'+00:00','+05:30')) = ?";
  const rows = await q<any>(pool, `SELECT o.*, (SELECT COUNT(*) FROM store_order_items i WHERE i.order_id = o.id) item_count FROM store_orders o WHERE o.retailer_id = ? AND ${day} ORDER BY o.id DESC`, [r, date]);
  const live = rows.filter((o) => !['cancelled', 'rejected'].includes(o.status));
  const sum = (f: (o: any) => boolean) => live.filter(f).reduce((t, o) => t + Number(o.total_paise), 0);
  const modes = ['cash', 'card', 'upi', 'cod'] as const;
  res.json({
    date, bills: live.filter((o) => o.channel === 'counter').length, online_orders: live.filter((o) => o.channel === 'online').length, cancelled: rows.length - live.length,
    total_sales: money(sum(() => true)), collected: money(sum((o) => o.payment_status === 'paid')), pending: money(sum((o) => o.payment_status !== 'paid')),
    by_mode: Object.fromEntries(modes.map((m) => [m, { amount: money(sum((o) => o.payment_method === m)), count: live.filter((o) => o.payment_method === m).length }])),
    orders: rows.map((o) => presentOrder(o)),
  });
}));

// ---------------------------------------------------------------------------------------------
// Reports and offers
// ---------------------------------------------------------------------------------------------
storeRouter.get('/reports/sales', asyncHandler(async (req, res) => {
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const { from, to } = z.object({ from: day.optional(), to: day.optional() }).parse(req.query);
  const end = to ?? todayIst(); const start = from ?? new Date(new Date(end + 'T00:00:00Z').getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  const r = req.auth!.userId;
  const ist = "DATE(CONVERT_TZ(o.created_at,'+00:00','+05:30'))";
  const byDay = await q<any>(pool, `SELECT ${ist} d, COUNT(*) n, SUM(o.total_paise) total FROM store_orders o WHERE o.retailer_id = ? AND o.status NOT IN ('cancelled','rejected') AND ${ist} BETWEEN ? AND ? GROUP BY d ORDER BY d`, [r, start, end]);
  const top = await q<any>(pool, `SELECT i.name, SUM(i.qty) qty, SUM(i.line_total_paise) amount FROM store_order_items i JOIN store_orders o ON o.id = i.order_id WHERE o.retailer_id = ? AND o.status NOT IN ('cancelled','rejected') AND ${ist} BETWEEN ? AND ? GROUP BY i.name ORDER BY amount DESC LIMIT 10`, [r, start, end]);
  const byChannel = await q<any>(pool, `SELECT o.channel, COUNT(*) n, SUM(o.total_paise) total FROM store_orders o WHERE o.retailer_id = ? AND o.status NOT IN ('cancelled','rejected') AND ${ist} BETWEEN ? AND ? GROUP BY o.channel`, [r, start, end]);
  res.json({ from: start, to: end, by_day: byDay.map((x) => ({ date: String(x.d).slice(0, 10), orders: Number(x.n), total: money(x.total) })), top_products: top.map((t) => ({ name: t.name, qty: Number(t.qty), amount: money(t.amount) })),
    by_channel: byChannel.map((c) => ({ channel: c.channel, orders: Number(c.n), total: money(c.total) })) });
}));

const offerBody = z.object({ title: z.string().trim().min(2).max(120), description: optText(300), starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), is_active: z.boolean().default(true) });
storeRouter.get('/offers', asyncHandler(async (req, res) => { res.json({ offers: await q<any>(pool, 'SELECT id, title, description, starts_on, ends_on, is_active FROM store_offers WHERE retailer_id = ? ORDER BY id DESC', [req.auth!.userId]) }); }));
storeRouter.post('/offers', asyncHandler(async (req, res) => {
  const b = offerBody.parse(req.body); const s = await liveStore(req);
  const r = await exec(pool, 'INSERT INTO store_offers (retailer_id, title, description, starts_on, ends_on, is_active) VALUES (?,?,?,?,?,?)', [s.retailer_id, b.title, b.description ?? null, b.starts_on ?? null, b.ends_on ?? null, b.is_active ? 1 : 0]);
  res.status(201).json(await q1(pool, 'SELECT id, title, description, starts_on, ends_on, is_active FROM store_offers WHERE id = ?', [r.insertId]));
}));
storeRouter.put('/offers/:id', asyncHandler(async (req, res) => {
  const b = offerBody.partial().parse(req.body); const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM store_offers WHERE id = ? AND retailer_id = ?', [id, req.auth!.userId]);
  if (!cur) throw notFound('Offer');
  await exec(pool, 'UPDATE store_offers SET title=?, description=?, starts_on=?, ends_on=?, is_active=? WHERE id = ?', [b.title ?? cur.title, b.description === undefined ? cur.description : b.description, b.starts_on === undefined ? cur.starts_on : b.starts_on, b.ends_on === undefined ? cur.ends_on : b.ends_on, b.is_active === undefined ? cur.is_active : b.is_active ? 1 : 0, id]);
  res.json(await q1(pool, 'SELECT id, title, description, starts_on, ends_on, is_active FROM store_offers WHERE id = ?', [id]));
}));
storeRouter.delete('/offers/:id', asyncHandler(async (req, res) => {
  const r = await exec(pool, 'DELETE FROM store_offers WHERE id = ? AND retailer_id = ?', [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Offer');
  res.status(204).end();
}));
