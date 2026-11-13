import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { toPaise } from '../../utils/money';
import { issueTokens } from '../auth/auth.routes';
import { addStoreCustomer, codeFromQr, distanceKm, money, openNow, presentOrder, presentProduct, presentStore, storeLive } from './store.service';
import { upiUri } from '../subscription/subscription.service';
import { currentSubscription } from '../retailerSales/retailerSales.routes';

/*
 * The end customer's side: sign up (optionally from a store's QR code, which adds them to that store's customers and pins the store
 * to the top of their home page), find stores near them, look at a store's menu, and order.
 */
export const customerRouter = Router();

const phone = z.string().regex(/^\d{10}$/, '10-digit phone');
const place = {
  address: z.string().trim().max(255).optional(), pincode: z.string().regex(/^\d{6}$/, 'Pincode is 6 digits').optional(),
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
};

/** Sign-up: details and location. `store_code` (from a store QR, or the Play Store install referrer) puts them in that store's customer list and pins it. */
customerRouter.post('/register', asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(120), phone, password: z.string().min(8).max(100), email: z.string().trim().toLowerCase().email().max(190).optional(),
    ...place, store_code: z.string().trim().max(300).optional(),
  }).parse(req.body);
  const hash = await bcrypt.hash(b.password, 10);
  const code = b.store_code ? codeFromQr(b.store_code) : null;
  let id: number; let joined: any = null;
  try {
    id = await withTx(async (c) => {
      if (await q1(c, 'SELECT id FROM users WHERE phone = ?', [b.phone])) throw new AppError(409, 'PHONE_TAKEN', 'This phone number is already registered. Sign in instead.');
      if (b.email) {
        await exec(c, 'UPDATE users SET email = NULL WHERE email = ? AND email_verified_at IS NULL', [b.email]);
        if (await q1(c, 'SELECT id FROM users WHERE email = ?', [b.email])) throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
      }
      const u = await exec(c, "INSERT INTO users (role, phone, email, name, password_hash) VALUES ('customer',?,?,?,?)", [b.phone, b.email ?? null, b.name, hash]);
      const store = code ? await q1<any>(c, 'SELECT * FROM retailer_stores WHERE code = ?', [code]) : null;
      await exec(c, 'INSERT INTO customer_profiles (user_id, address, pincode, lat, lng, pinned_retailer_id, joined_via) VALUES (?,?,?,?,?,?,?)',
        [u.insertId, b.address ?? null, b.pincode ?? null, b.lat ?? null, b.lng ?? null, store?.retailer_id ?? null, store ? `qr:${store.code}` : null]);
      if (store) { await addStoreCustomer(c, store.retailer_id, { name: b.name, phone: b.phone, customerId: u.insertId, source: 'qr' }); joined = store; }
      return u.insertId as number;
    });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, String(e.message).includes('uq_users_email') ? 'EMAIL_TAKEN' : 'PHONE_TAKEN', 'Phone or email already registered');
    throw e;
  }
  if (joined) notifyUsers([joined.retailer_id], 'New customer', `${b.name} joined your store.`, { type: 'store_customer' });
  res.status(201).json({ id, pinned_store: joined ? presentStore(joined) : null, ...(await issueTokens(id, 'customer', null, { req })) });
}));

customerRouter.use(authenticate, requireRole('customer'));

const mine = async (id: number) => (await q1<any>(pool, 'SELECT u.id, u.name, u.phone, u.email, cp.* FROM users u JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.id = ?', [id]))!;

customerRouter.get('/me', asyncHandler(async (req, res) => {
  const m = await mine(req.auth!.userId);
  res.json({ id: m.id, name: m.name, phone: m.phone, email: m.email, address: m.address, pincode: m.pincode, lat: m.lat == null ? null : Number(m.lat), lng: m.lng == null ? null : Number(m.lng), pinned_retailer_id: m.pinned_retailer_id });
}));
customerRouter.put('/me', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(120).optional(), ...place }).parse(req.body);
  const m = await mine(req.auth!.userId);
  if (b.name) await exec(pool, 'UPDATE users SET name = ? WHERE id = ?', [b.name, m.id]);
  await exec(pool, 'UPDATE customer_profiles SET address = ?, pincode = ?, lat = ?, lng = ? WHERE user_id = ?', [b.address ?? m.address, b.pincode ?? m.pincode, b.lat ?? m.lat, b.lng ?? m.lng, m.id]);
  res.json({ ok: true });
}));

// ---- Finding stores
type Where = { lat?: number | null; lng?: number | null };
const coords = z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() });

/** Live stores (active subscription, switched on), each with its distance from the customer when both places are known. */
async function liveStores(where: Where, opts: { q?: string; category?: string; limit?: number } = {}) {
  const args: unknown[] = []; const cond: string[] = ['s.is_active = 1', "EXISTS (SELECT 1 FROM retailer_subscriptions rs WHERE rs.retailer_id = s.retailer_id AND rs.status = 'active' AND rs.ends_at > UTC_TIMESTAMP())"];
  if (opts.q) { cond.push('(s.name LIKE ? OR s.address LIKE ? OR EXISTS (SELECT 1 FROM store_products p WHERE p.retailer_id = s.retailer_id AND p.deleted_at IS NULL AND p.is_active = 1 AND (p.name LIKE ? OR p.brand LIKE ?)))'); const l = `%${opts.q}%`; args.push(l, l, l, l); }
  if (opts.category) { cond.push('EXISTS (SELECT 1 FROM store_products p WHERE p.retailer_id = s.retailer_id AND p.deleted_at IS NULL AND p.is_active = 1 AND p.category = ?)'); args.push(opts.category); }
  const rows = await q<any>(pool, `SELECT s.* FROM retailer_stores s WHERE ${cond.join(' AND ')} LIMIT 500`, args);
  const withDist = rows.map((s) => ({ s, d: where.lat != null && where.lng != null && s.lat != null && s.lng != null ? distanceKm(where.lat, where.lng, Number(s.lat), Number(s.lng)) : null }));
  withDist.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || a.s.name.localeCompare(b.s.name));
  return withDist.slice(0, opts.limit ?? 40);
}
const storeCard = (x: { s: any; d: number | null }) => presentStore(x.s, { distance: x.d });

async function whereOf(req: any, qs: { lat?: number; lng?: number }): Promise<Where> {
  if (qs.lat != null && qs.lng != null) return { lat: qs.lat, lng: qs.lng };
  const m = await mine(req.auth.userId);
  return { lat: m.lat == null ? null : Number(m.lat), lng: m.lng == null ? null : Number(m.lng) };
}

// The home page: the pinned store first, stores near you, the categories they sell, and their offers as banners.
customerRouter.get('/home', asyncHandler(async (req, res) => {
  const qs = coords.parse(req.query);
  const w = await whereOf(req, qs); const m = await mine(req.auth!.userId);
  const near = await liveStores(w, { limit: 30 });
  let pinned: any = null;
  if (m.pinned_retailer_id) {
    const ps = await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [m.pinned_retailer_id]);
    if (ps && (await storeLive(pool, ps))) pinned = storeCard({ s: ps, d: w.lat != null && ps.lat != null ? distanceKm(w.lat, w.lng!, Number(ps.lat), Number(ps.lng)) : null });
  }
  const ids = [...new Set([...(pinned ? [pinned.id] : []), ...near.map((x) => x.s.retailer_id)])];
  const cats = ids.length ? await q<any>(pool, `SELECT category, COUNT(*) n FROM store_products WHERE retailer_id IN (?) AND deleted_at IS NULL AND is_active = 1 AND category IS NOT NULL GROUP BY category ORDER BY n DESC LIMIT 12`, [ids]) : [];
  const offers = ids.length ? await q<any>(pool, `SELECT o.id, o.retailer_id, o.title, o.description, s.name store_name FROM store_offers o JOIN retailer_stores s ON s.retailer_id = o.retailer_id
    WHERE o.retailer_id IN (?) AND o.is_active = 1 AND (o.starts_on IS NULL OR o.starts_on <= CURDATE()) AND (o.ends_on IS NULL OR o.ends_on >= CURDATE()) ORDER BY (o.retailer_id = ?) DESC, o.id DESC LIMIT 10`, [ids, pinned?.id ?? 0]) : [];
  res.json({ pinned_store: pinned, nearby_stores: near.filter((x) => x.s.retailer_id !== pinned?.id).map(storeCard), categories: cats.map((c) => ({ name: c.category, products: Number(c.n) })), banners: offers });
}));

customerRouter.get('/stores', asyncHandler(async (req, res) => {
  const qs = coords.extend({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }).parse(req.query);
  res.json({ stores: (await liveStores(await whereOf(req, qs), { q: qs.q, category: qs.category, limit: qs.limit })).map(storeCard) });
}));

// Products and stores matching a search, across the stores near the customer.
customerRouter.get('/search', asyncHandler(async (req, res) => {
  const qs = coords.extend({ q: z.string().trim().min(1).max(100) }).parse(req.query);
  const w = await whereOf(req, qs);
  const stores = (await liveStores(w, { q: qs.q, limit: 20 }));
  const ids = stores.map((x) => x.s.retailer_id);
  const l = `%${qs.q}%`;
  const products = ids.length ? await q<any>(pool, 'SELECT * FROM store_products WHERE retailer_id IN (?) AND deleted_at IS NULL AND is_active = 1 AND (name LIKE ? OR brand LIKE ?) ORDER BY (stock_qty > 0) DESC LIMIT 40', [ids, l, l]) : [];
  const nameOf = new Map(stores.map((x) => [x.s.retailer_id, x.s.name]));
  res.json({ stores: stores.filter((x) => x.s.name.toLowerCase().includes(qs.q.toLowerCase()) || x.s.address?.toLowerCase().includes(qs.q.toLowerCase())).map(storeCard),
    products: products.map((p) => ({ ...presentProduct(p), store_id: p.retailer_id, store_name: nameOf.get(p.retailer_id) })) });
}));

async function storeView(id: number, w: Where) {
  const s = await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [id]);
  if (!s || !(await storeLive(pool, s))) throw notFound('Store');
  const d = w.lat != null && w.lng != null && s.lat != null ? distanceKm(w.lat, w.lng, Number(s.lat), Number(s.lng)) : null;
  const cats = await q<any>(pool, 'SELECT category, COUNT(*) n FROM store_products WHERE retailer_id = ? AND deleted_at IS NULL AND is_active = 1 AND category IS NOT NULL GROUP BY category ORDER BY category', [id]);
  const offers = await q<any>(pool, `SELECT id, title, description FROM store_offers WHERE retailer_id = ? AND is_active = 1 AND (starts_on IS NULL OR starts_on <= CURDATE()) AND (ends_on IS NULL OR ends_on >= CURDATE()) ORDER BY id DESC LIMIT 10`, [id]);
  return { store: presentStore(s, { distance: d }), categories: cats.map((c) => ({ name: c.category, products: Number(c.n) })), offers };
}

customerRouter.get('/stores/:id', asyncHandler(async (req, res) => { res.json(await storeView(idParam(req), await whereOf(req, coords.parse(req.query)))); }));

customerRouter.get('/stores/:id/products', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const qs = z.object({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const s = await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [id]);
  if (!s || !(await storeLive(pool, s))) throw notFound('Store');
  const where = ['retailer_id = ?', 'deleted_at IS NULL', 'is_active = 1']; const args: unknown[] = [id];
  if (qs.q) { where.push('(name LIKE ? OR brand LIKE ?)'); args.push(`%${qs.q}%`, `%${qs.q}%`); }
  if (qs.category) { where.push('category = ?'); args.push(qs.category); }
  const rows = await q<any>(pool, `SELECT * FROM store_products WHERE ${where.join(' AND ')} ORDER BY (stock_qty > 0) DESC, category, name LIMIT ? OFFSET ?`, [...args, qs.limit, qs.offset]);
  res.json({ products: rows.map((p) => { const o = presentProduct(p); return { ...o, stock_qty: Math.min(o.stock_qty, 20) }; }) });     // the exact stock stays private
}));

// Scanning a store's QR code: the store opens, and the customer joins its customer list (once).
customerRouter.post('/scan', asyncHandler(async (req, res) => {
  const b = z.object({ code: z.string().trim().min(1).max(300), ...coords.shape }).parse(req.body);
  const code = codeFromQr(b.code);
  if (!code) throw new AppError(400, 'NOT_A_STORE_CODE', 'This is not an AAYME store code');
  const s = await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE code = ?', [code]);
  if (!s) throw notFound('Store');
  const m = await mine(req.auth!.userId); const u = (await q1<any>(pool, 'SELECT name, phone FROM users WHERE id = ?', [m.id]))!;
  const view = await storeView(s.retailer_id, await whereOf(req, b));
  const before = await q1(pool, 'SELECT 1 FROM store_customers WHERE retailer_id = ? AND phone = ?', [s.retailer_id, u.phone]);
  await addStoreCustomer(pool, s.retailer_id, { name: u.name, phone: u.phone, customerId: m.id, source: 'qr' });
  if (!m.pinned_retailer_id) await exec(pool, 'UPDATE customer_profiles SET pinned_retailer_id = ? WHERE user_id = ?', [s.retailer_id, m.id]);
  if (!before) notifyUsers([s.retailer_id], 'New customer', `${u.name} joined your store.`, { type: 'store_customer' });
  res.json({ ...view, joined: !before });
}));

customerRouter.post('/pin', asyncHandler(async (req, res) => {
  const { retailer_id } = z.object({ retailer_id: z.number().int().positive().nullable() }).parse(req.body);
  if (retailer_id) { const s = await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [retailer_id]); if (!s) throw notFound('Store'); }
  await exec(pool, 'UPDATE customer_profiles SET pinned_retailer_id = ? WHERE user_id = ?', [retailer_id, req.auth!.userId]);
  res.json({ pinned_retailer_id: retailer_id });
}));

// ---- Orders
customerRouter.post('/orders', asyncHandler(async (req, res) => {
  const b = z.object({
    retailer_id: z.number().int().positive(), items: z.array(z.object({ product_id: z.number().int().positive(), qty: z.number().int().min(1).max(1000) })).min(1).max(100),
    payment_method: z.enum(['cod', 'upi']), address: z.string().trim().min(3).max(255), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), note: z.string().trim().max(300).optional(),
  }).parse(req.body);
  const me = req.auth!.userId;
  const u = (await q1<any>(pool, 'SELECT name, phone FROM users WHERE id = ?', [me]))!;
  const s = await q1<any>(pool, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [b.retailer_id]);
  if (!s || !(await storeLive(pool, s))) throw notFound('Store');
  if (!s.delivery_enabled) throw new AppError(409, 'NO_DELIVERY', 'This store does not deliver');
  if (!openNow(s)) throw new AppError(409, 'STORE_CLOSED', 'This store is closed right now');
  if (b.payment_method === 'cod' && !s.accepts_cod) throw new AppError(409, 'COD_OFF', 'This store does not take cash on delivery');
  if (b.payment_method === 'upi' && !(s.accepts_upi && s.upi_id)) throw new AppError(409, 'UPI_OFF', 'This store does not take UPI payments');

  const out = await withTx(async (c) => {
    const lines: { p: any; qty: number }[] = [];
    for (const i of b.items) {
      const p = await q1<any>(c, 'SELECT * FROM store_products WHERE id = ? AND retailer_id = ? AND deleted_at IS NULL AND is_active = 1 FOR UPDATE', [i.product_id, b.retailer_id]);
      if (!p) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'One of the products is no longer sold here');
      if (Number(p.stock_qty) < i.qty) throw new AppError(409, 'OUT_OF_STOCK', `${p.name}: only ${p.stock_qty} left`);
      lines.push({ p, qty: i.qty });
    }
    const subtotal = lines.reduce((t, l) => t + Number(l.p.price_paise) * l.qty, 0);
    if (subtotal < Number(s.min_order_paise)) throw new AppError(409, 'BELOW_MINIMUM', `The minimum order here is ₹${money(s.min_order_paise)}`);
    const free = s.free_delivery_above_paise != null && subtotal >= Number(s.free_delivery_above_paise);
    const fee = free ? 0 : Number(s.delivery_fee_paise);
    const o = await exec(c, `INSERT INTO store_orders (retailer_id, customer_id, customer_name, customer_phone, channel, status, payment_method, payment_status, subtotal_paise, delivery_fee_paise, total_paise, delivery_address, lat, lng, note)
      VALUES (?,?,?,?,'online','placed',?,'pending',?,?,?,?,?,?,?)`, [b.retailer_id, me, u.name, u.phone, b.payment_method, subtotal, fee, subtotal + fee, b.address, b.lat ?? null, b.lng ?? null, b.note ?? null]);
    for (const l of lines) {
      await exec(c, 'INSERT INTO store_order_items (order_id, product_id, name, unit, qty, unit_price_paise, cost_paise, line_total_paise) VALUES (?,?,?,?,?,?,?,?)', [o.insertId, l.p.id, l.p.name, l.p.unit, l.qty, l.p.price_paise, l.p.cost_paise, Number(l.p.price_paise) * l.qty]);
      await exec(c, 'UPDATE store_products SET stock_qty = stock_qty - ? WHERE id = ?', [l.qty, l.p.id]);          // held for this order
    }
    await addStoreCustomer(c, b.retailer_id, { name: u.name, phone: u.phone, customerId: me, source: 'online' });
    return { id: o.insertId as number, total: subtotal + fee };
  });
  notifyUsers([b.retailer_id], 'New order', `Order #${out.id} · ₹${money(out.total)} from ${u.name}`, { type: 'store_order', id: out.id });
  res.status(201).json({ id: out.id, total: money(out.total), payment_method: b.payment_method, upi_link: b.payment_method === 'upi' ? upiUri(s.upi_id, s.upi_payee ?? s.name, out.total, `Order ${out.id}`) : null });
}));

customerRouter.get('/orders', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `SELECT o.*, s.name store_name, (SELECT COUNT(*) FROM store_order_items i WHERE i.order_id = o.id) item_count FROM store_orders o JOIN retailer_stores s ON s.retailer_id = o.retailer_id
    WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 100`, [req.auth!.userId]);
  res.json({ orders: rows.map((o) => presentOrder(o)) });
}));
customerRouter.get('/orders/:id', asyncHandler(async (req, res) => {
  const o = await q1<any>(pool, 'SELECT o.*, s.name store_name, s.phone store_phone FROM store_orders o JOIN retailer_stores s ON s.retailer_id = o.retailer_id WHERE o.id = ? AND o.customer_id = ?', [idParam(req), req.auth!.userId]);
  if (!o) throw notFound('Order');
  res.json({ ...presentOrder(o, await q<any>(pool, 'SELECT * FROM store_order_items WHERE order_id = ?', [o.id])), store_phone: o.store_phone });
}));
customerRouter.post('/orders/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const o = await withTx(async (c) => {
    const row = await q1<any>(c, 'SELECT * FROM store_orders WHERE id = ? AND customer_id = ? FOR UPDATE', [id, req.auth!.userId]);
    if (!row) throw notFound('Order');
    if (row.status !== 'placed') throw new AppError(409, 'TOO_LATE', 'The store has already accepted this order. Call the store to change it.');
    for (const i of await q<any>(c, 'SELECT product_id, qty FROM store_order_items WHERE order_id = ? AND product_id IS NOT NULL', [id])) await exec(c, 'UPDATE store_products SET stock_qty = stock_qty + ? WHERE id = ?', [i.qty, i.product_id]);
    await exec(c, "UPDATE store_orders SET status = 'cancelled' WHERE id = ?", [id]);
    return row;
  });
  notifyUsers([o.retailer_id], 'Order cancelled', `Order #${id} was cancelled by the customer.`, { type: 'store_order', id });
  res.json({ status: 'cancelled' });
}));

export { currentSubscription, toPaise };
