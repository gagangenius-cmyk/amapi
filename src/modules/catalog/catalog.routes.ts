import crypto from 'crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { Conn, exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise, toPaise } from '../../utils/money';
import { assertSubscriptionActive } from '../distributors/subscription';
import { changeStock, loadTiers } from './stock';
import { todayUtc } from './batches';
import { EXT, sniffImage, storage } from '../../services/storage';

export const catalogRouter = Router();
catalogRouter.use(authenticate);

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------
export function stockStatus(p: { stock_qty: number; low_stock_threshold: number }): 'out' | 'low' | 'ok' {
  if (p.stock_qty <= 0) return 'out';
  return p.stock_qty <= p.low_stock_threshold ? 'low' : 'ok';
}

/** Name as shown to buyers and printed on invoices: "Rice" + variant "5 kg" -> "Rice · 5 kg". */
export const displayName = (p: { name: string; variant_label?: string | null }) => (p.variant_label ? `${p.name} · ${p.variant_label}` : p.name);

export const MAX_IMAGES = 5;
export const imageUrl = (key: string) => `/api/v1/media/${key}`;

export function presentProduct(p: any, tiers: { min_qty: number; price_paise: number }[] = [], images: { id: number; file_key: string }[] = []) {
  const price = Number(p.price_paise);
  const mrp = p.mrp_paise == null ? null : Number(p.mrp_paise);
  return {
    id: p.id, distributor_id: p.distributor_id, name: p.name, display_name: displayName(p), sku: p.sku, barcode: p.barcode ?? null, variant_group: p.variant_group ?? null, variant_label: p.variant_label ?? null, category: p.category, brand: p.brand, unit: p.unit,
    description: p.description, hsn: p.hsn, gst_rate_bps: p.gst_rate_bps,
    price: fromPaise(price), mrp: mrp == null ? null : fromPaise(mrp),
    discount_pct: mrp && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0,
    stock_qty: p.stock_qty, stock_status: stockStatus(p), min_order_qty: p.min_order_qty, low_stock_threshold: p.low_stock_threshold,
    is_active: !!p.is_active,
    tiers: tiers.map((t) => ({ min_qty: t.min_qty, price: fromPaise(t.price_paise) })),
    images: images.map((i) => ({ id: i.id, url: imageUrl(i.file_key) })), image_url: images[0] ? imageUrl(images[0].file_key) : null,
  };
}

export async function presentProducts(c: Conn, rows: any[]) {
  const ids = rows.map((r) => r.id);
  const tiers = await loadTiers(c, ids);
  const imgs = ids.length ? await q<any>(c, 'SELECT id, product_id, file_key FROM product_images WHERE product_id IN (?) ORDER BY position, id', [ids]) : [];
  return rows.map((r) => presentProduct(r, tiers.get(r.id) ?? [], imgs.filter((i) => i.product_id === r.id)));
}

/** What a retailer may see of a distributor's catalog: active, not deleted; searchable. */
export async function storefrontProducts(distributorId: number, opts: { q?: string; category?: string; limit?: number; offset?: number } = {}) {
  const where = ['distributor_id = ?', 'deleted_at IS NULL', 'is_active = 1'];
  const args: unknown[] = [distributorId];
  if (opts.q) { where.push('(name LIKE ? OR brand LIKE ? OR sku LIKE ? OR barcode = ? OR variant_group LIKE ?)'); const like = `%${opts.q}%`; args.push(like, like, like, opts.q, like); }
  if (opts.category) { where.push('category = ?'); args.push(opts.category); }
  const rows = await q<any>(pool, `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY (stock_qty > 0) DESC, COALESCE(variant_group, name), name, variant_label LIMIT ? OFFSET ?`, [...args, opts.limit ?? 200, opts.offset ?? 0]);
  const categories = (await q<any>(pool, 'SELECT DISTINCT category FROM products WHERE distributor_id = ? AND deleted_at IS NULL AND is_active = 1 AND category IS NOT NULL ORDER BY category', [distributorId])).map((r) => r.category as string);
  return { products: await presentProducts(pool, rows), categories };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------
const GST_SLABS = [0, 25, 300, 500, 1200, 1800, 2800]; // 0%, 0.25%, 3%, 5%, 12%, 18%, 28%
const optText = (max: number) => z.string().trim().max(max).transform((s) => (s === '' ? null : s)).nullable().optional();
const money = z.union([z.string(), z.number()]);

const tierSchema = z.object({ min_qty: z.number().int().min(2).max(1_000_000), price: money });

const productFields = {
  name: z.string().trim().min(1).max(190),
  sku: optText(60),
  barcode: z.string().trim().regex(/^[A-Za-z0-9\-]{4,40}$/, 'Barcode is 4 to 40 letters, digits or dashes').nullable().optional().or(z.literal('').transform(() => null)),
  variant_group: optText(80),
  variant_label: optText(60),
  category: optText(80),
  brand: optText(80),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  description: optText(500),
  price: money,
  mrp: money.nullable().optional(),
  hsn: z.string().trim().regex(/^\d{4,8}$/, 'HSN is 4 to 8 digits').nullable().optional().or(z.literal('').transform(() => null)),
  gst_rate_bps: z.number().int().refine((v) => GST_SLABS.includes(v), 'GST must be 0, 0.25, 3, 5, 12, 18 or 28 %'),
  min_order_qty: z.number().int().min(1).max(1_000_000),
  low_stock_threshold: z.number().int().min(0).max(1_000_000),
  is_active: z.boolean(),
  tiers: z.array(tierSchema).max(5),
};

const createSchema = z.object({
  ...productFields,
  gst_rate_bps: productFields.gst_rate_bps.default(0),
  min_order_qty: productFields.min_order_qty.default(1),
  low_stock_threshold: productFields.low_stock_threshold.default(10),
  is_active: productFields.is_active.default(true),
  tiers: productFields.tiers.default([]),
  stock_qty: z.number().int().min(0).max(100_000_000).default(0),
});
const patchSchema = z.object(productFields).partial();

/** Checks that cross fields: MRP not below price, tier prices lower than base and strictly falling as quantity rises. */
function checkPricing(pricePaise: number, mrpPaise: number | null, tiers: { min_qty: number; price_paise: number }[]) {
  if (pricePaise < 0) throw new AppError(400, 'BAD_PRICE', 'Price cannot be negative');
  if (mrpPaise != null && mrpPaise < pricePaise) throw new AppError(400, 'BAD_MRP', 'MRP cannot be lower than the selling price');
  const sorted = [...tiers].sort((a, b) => a.min_qty - b.min_qty);
  let prev = pricePaise;
  for (const t of sorted) {
    if (t.price_paise >= prev) throw new AppError(400, 'BAD_TIER', 'Each quantity break must have a lower price than the one before');
    prev = t.price_paise;
  }
  if (new Set(sorted.map((t) => t.min_qty)).size !== sorted.length) throw new AppError(400, 'BAD_TIER', 'Two quantity breaks have the same quantity');
  return sorted;
}

const toTierRows = (tiers: { min_qty: number; price: string | number }[]) => tiers.map((t) => ({ min_qty: t.min_qty, price_paise: toPaise(t.price) }));

async function replaceTiers(c: Conn, productId: number, tiers: { min_qty: number; price_paise: number }[]) {
  await exec(c, 'DELETE FROM product_price_tiers WHERE product_id = ?', [productId]);
  if (tiers.length) await exec(c, 'INSERT INTO product_price_tiers (product_id, min_qty, price_paise) VALUES ?', [tiers.map((t) => [productId, t.min_qty, t.price_paise])]);
}

async function recordPrice(c: Conn, productId: number, oldPaise: number | null, newPaise: number, actorId: number) {
  if (oldPaise === newPaise) return;
  await exec(c, 'INSERT INTO price_history (product_id, old_price_paise, new_price_paise, actor_id) VALUES (?,?,?,?)', [productId, oldPaise, newPaise, actorId]);
}

const dupSku = (e: any) => {
  if (e?.code === 'ER_DUP_ENTRY' && String(e.message).includes('uq_prod_sku')) throw new AppError(409, 'SKU_TAKEN', 'Another product already uses this SKU');
  if (e?.code === 'ER_DUP_ENTRY' && String(e.message).includes('uq_prod_barcode')) throw new AppError(409, 'BARCODE_TAKEN', 'Another product already uses this barcode');
  throw e;
};

const writer = [requireRole('distributor')];

// ---------------------------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------------------------
// Own catalog with search, filters and paging. Also returns counts for the filter chips and the category list.
catalogRouter.get('/', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const qs = z.object({
    q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(),
    status: z.enum(['all', 'active', 'low', 'out', 'hidden']).default('all'),
    limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  const d = req.auth!.distributorId!;
  const where = ['distributor_id = ?', 'deleted_at IS NULL'];
  const args: unknown[] = [d];
  if (qs.q) { where.push('(name LIKE ? OR brand LIKE ? OR sku LIKE ? OR category LIKE ? OR barcode = ?)'); const like = `%${qs.q}%`; args.push(like, like, like, like, qs.q); }
  if (qs.category) { where.push('category = ?'); args.push(qs.category); }
  if (qs.status === 'active') where.push('is_active = 1');
  if (qs.status === 'hidden') where.push('is_active = 0');
  if (qs.status === 'out') where.push('stock_qty <= 0');
  if (qs.status === 'low') where.push('stock_qty > 0 AND stock_qty <= low_stock_threshold');

  const rows = await q<any>(pool, `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`, [...args, qs.limit, qs.offset]);
  const total = (await q1<any>(pool, `SELECT COUNT(*) n FROM products WHERE ${where.join(' AND ')}`, args))!.n;
  const s = (await q1<any>(pool, `SELECT COUNT(*) total, COALESCE(SUM(is_active = 1),0) active, COALESCE(SUM(is_active = 0),0) hidden,
      COALESCE(SUM(stock_qty <= 0),0) out_of_stock, COALESCE(SUM(stock_qty > 0 AND stock_qty <= low_stock_threshold),0) low
    FROM products WHERE distributor_id = ? AND deleted_at IS NULL`, [d]))!;
  const categories = (await q<any>(pool, 'SELECT category, COUNT(*) n FROM products WHERE distributor_id = ? AND deleted_at IS NULL AND category IS NOT NULL GROUP BY category ORDER BY category', [d]))
    .map((r) => ({ name: r.category as string, count: Number(r.n) }));
  res.json({
    products: await presentProducts(pool, rows), total: Number(total), limit: qs.limit, offset: qs.offset, categories,
    summary: { total: Number(s.total), active: Number(s.active), hidden: Number(s.hidden), out_of_stock: Number(s.out_of_stock), low_stock: Number(s.low) },
  });
}));

// Find a product by scanning its barcode.
catalogRouter.get('/lookup', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const { barcode } = z.object({ barcode: z.string().trim().min(1).max(40) }).parse(req.query);
  const p = await q1<any>(pool, 'SELECT * FROM products WHERE distributor_id = ? AND barcode = ? AND deleted_at IS NULL', [req.auth!.distributorId, barcode]);
  if (!p) throw notFound('Product');
  res.json((await presentProducts(pool, [p]))[0]);
}));

// Batches that are expired or will expire within `days`, with what is left in them.
catalogRouter.get('/expiring', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(0).max(365).default(30) }).parse(req.query);
  const rows = await q<any>(pool, `SELECT b.id, b.product_id, p.name, p.variant_label, b.batch_no, DATE_FORMAT(b.expiry_date, '%Y-%m-%d') expiry_date, b.qty_remaining,
      DATEDIFF(b.expiry_date, UTC_DATE()) days_left
    FROM product_batches b JOIN products p ON p.id = b.product_id
    WHERE b.distributor_id = ? AND b.qty_remaining > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= DATE_ADD(UTC_DATE(), INTERVAL ? DAY) AND p.deleted_at IS NULL
    ORDER BY b.expiry_date`, [req.auth!.distributorId, days]);
  res.json({ batches: rows.map((r) => ({ id: r.id, product_id: r.product_id, name: displayName(r), batch_no: r.batch_no, expiry_date: r.expiry_date, qty: r.qty_remaining, days_left: Number(r.days_left), expired: Number(r.days_left) < 0 })) });
}));

// One product with its stock and price history.
catalogRouter.get('/:id', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const id = idParam(req);
  const p = await q1<any>(pool, 'SELECT * FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [id, req.auth!.distributorId]);
  if (!p) throw notFound('Product');
  const [product] = await presentProducts(pool, [p]);
  const movements = await q<any>(pool, `SELECT m.id, m.delta, m.balance_after, m.reason, m.ref_order_id, m.note, m.created_at, u.name AS actor
    FROM stock_movements m LEFT JOIN users u ON u.id = m.actor_id WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 30`, [id]);
  const prices = await q<any>(pool, 'SELECT old_price_paise, new_price_paise, created_at FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT 15', [id]);
  const batches = await q<any>(pool, "SELECT id, batch_no, DATE_FORMAT(expiry_date, '%Y-%m-%d') expiry_date, qty_received, qty_remaining, received_at FROM product_batches WHERE product_id = ? ORDER BY expiry_date IS NULL, expiry_date, id", [id]);
  res.json({
    product, stock_history: movements,
    batches: batches.map((b) => ({ ...b, expired: !!b.expiry_date && b.expiry_date < todayUtc() })),
    price_history: prices.map((r) => ({ old_price: r.old_price_paise == null ? null : fromPaise(Number(r.old_price_paise)), new_price: fromPaise(Number(r.new_price_paise)), at: r.created_at })),
  });
}));

// ---------------------------------------------------------------------------------------------
// Create / edit / delete
// ---------------------------------------------------------------------------------------------
catalogRouter.post('/', ...writer, asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  const price = toPaise(b.price);
  const mrp = b.mrp == null || b.mrp === '' ? null : toPaise(b.mrp);
  const tiers = checkPricing(price, mrp, toTierRows(b.tiers));
  try {
    const id = await withTx(async (c) => {
      const r = await exec(c, `INSERT INTO products (distributor_id, name, sku, barcode, variant_group, variant_label, category, brand, unit, description, price_paise, mrp_paise, stock_qty, min_order_qty, low_stock_threshold, hsn, gst_rate_bps, is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`, [d, b.name, b.sku ?? null, b.barcode ?? null, b.variant_group ?? null, b.variant_label ?? null, b.category ?? null, b.brand ?? null, b.unit, b.description ?? null, price, mrp, b.min_order_qty, b.low_stock_threshold, b.hsn ?? null, b.gst_rate_bps, b.is_active ? 1 : 0]);
      await replaceTiers(c, r.insertId, tiers);
      await recordPrice(c, r.insertId, null, price, d);
      if (b.stock_qty > 0) await changeStock(c, { productId: r.insertId, distributorId: d, delta: b.stock_qty, reason: 'initial', actorId: d });
      return r.insertId;
    });
    const p = await q1<any>(pool, 'SELECT * FROM products WHERE id = ?', [id]);
    res.status(201).json((await presentProducts(pool, [p]))[0]);
  } catch (e) { dupSku(e); }
}));

// Edit details, price and quantity breaks. Stock is deliberately NOT editable here: use POST /:id/stock so concurrent
// sales can never be overwritten by a stale screen.
catalogRouter.patch('/:id', ...writer, asyncHandler(async (req, res) => {
  const body = patchSchema.parse(req.body);
  if ('stock_qty' in (req.body ?? {})) throw new AppError(400, 'USE_STOCK_ENDPOINT', 'Change stock with POST /catalog/:id/stock');
  const id = idParam(req);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  try {
    await withTx(async (c) => {
      const cur = await q1<any>(c, 'SELECT * FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL FOR UPDATE', [id, d]);
      if (!cur) throw notFound('Product');
      const price = body.price !== undefined ? toPaise(body.price) : Number(cur.price_paise);
      const mrp = body.mrp !== undefined ? (body.mrp == null || body.mrp === '' ? null : toPaise(body.mrp)) : cur.mrp_paise == null ? null : Number(cur.mrp_paise);
      const tiers = body.tiers !== undefined ? toTierRows(body.tiers) : (await loadTiers(c, [id])).get(id) ?? [];
      checkPricing(price, mrp, tiers);
      const pick = <K extends keyof typeof body>(k: K, curVal: any) => (body[k] !== undefined ? body[k] : curVal);
      await exec(c, `UPDATE products SET name=?, sku=?, barcode=?, variant_group=?, variant_label=?, category=?, brand=?, unit=?, description=?, price_paise=?, mrp_paise=?, min_order_qty=?, low_stock_threshold=?, hsn=?, gst_rate_bps=?, is_active=? WHERE id=?`, [
        pick('name', cur.name), pick('sku', cur.sku), pick('barcode', cur.barcode), pick('variant_group', cur.variant_group), pick('variant_label', cur.variant_label), pick('category', cur.category), pick('brand', cur.brand), pick('unit', cur.unit), pick('description', cur.description),
        price, mrp, pick('min_order_qty', cur.min_order_qty), pick('low_stock_threshold', cur.low_stock_threshold), pick('hsn', cur.hsn), pick('gst_rate_bps', cur.gst_rate_bps),
        body.is_active === undefined ? cur.is_active : body.is_active ? 1 : 0, id,
      ]);
      if (body.tiers !== undefined) await replaceTiers(c, id, tiers);
      if (price !== Number(cur.price_paise)) {
        await recordPrice(c, id, Number(cur.price_paise), price, d);
        await audit(d, 'catalog.price_change', 'product', id, { from: fromPaise(Number(cur.price_paise)), to: fromPaise(price) }, c);
      }
    });
    const p = await q1<any>(pool, 'SELECT * FROM products WHERE id = ?', [id]);
    res.json((await presentProducts(pool, [p]))[0]);
  } catch (e) { dupSku(e); }
}));

// Change stock safely. Either add/remove an amount, or set a counted figure while stating what you believed it was.
catalogRouter.post('/:id/stock', ...writer, asyncHandler(async (req, res) => {
  const b = z.union([
    z.object({ delta: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 10_000_000), note: z.string().trim().max(200).optional() }),
    z.object({ set_to: z.number().int().min(0).max(100_000_000), expected: z.number().int(), note: z.string().trim().max(200).optional() }),
  ]).parse(req.body);
  const id = idParam(req);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  const balance = await withTx(async (c) => {
    const cur = await q1<any>(c, 'SELECT stock_qty FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL FOR UPDATE', [id, d]);
    if (!cur) throw notFound('Product');
    if ('delta' in b) return changeStock(c, { productId: id, distributorId: d, delta: b.delta, reason: 'manual', note: b.note, actorId: d });
    // A stock count: only applied if nothing moved since the person looked, otherwise they are told the real number.
    if (cur.stock_qty !== b.expected) throw new AppError(409, 'STOCK_CHANGED', `Stock is now ${cur.stock_qty}, not ${b.expected}. Review it and try again.`, { current: cur.stock_qty });
    return changeStock(c, { productId: id, distributorId: d, delta: b.set_to - cur.stock_qty, reason: 'correction', note: b.note ?? 'Stock count', actorId: d });
  });
  res.json({ stock_qty: balance });
}));

catalogRouter.post('/:id/duplicate', ...writer, asyncHandler(async (req, res) => {
  const id = idParam(req);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  const id2 = await withTx(async (c) => {
    const cur = await q1<any>(c, 'SELECT * FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [id, d]);
    if (!cur) throw notFound('Product');
    const r = await exec(c, `INSERT INTO products (distributor_id, name, sku, category, brand, unit, description, price_paise, mrp_paise, stock_qty, min_order_qty, low_stock_threshold, hsn, gst_rate_bps, is_active)
      VALUES (?,?,NULL,?,?,?,?,?,?,0,?,?,?,?,0)`, [d, `${cur.name} (copy)`.slice(0, 190), cur.category, cur.brand, cur.unit, cur.description, cur.price_paise, cur.mrp_paise, cur.min_order_qty, cur.low_stock_threshold, cur.hsn, cur.gst_rate_bps]);
    const tiers = (await loadTiers(c, [id])).get(id) ?? [];
    await replaceTiers(c, r.insertId, tiers);
    await recordPrice(c, r.insertId, null, Number(cur.price_paise), d);
    return r.insertId; // starts hidden with no stock, so a copy can never be sold by accident
  });
  res.status(201).json((await presentProducts(pool, [(await q1<any>(pool, 'SELECT * FROM products WHERE id = ?', [id2]))]))[0]);
}));

// ---------------------------------------------------------------------------------------------
// Photos: raw image bytes in the request body (jpeg / png / webp, up to 1.5 MB, 5 per product). The first one is the cover.
// ---------------------------------------------------------------------------------------------
const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1.5mb' });
const imagesOf = async (productId: number) => (await presentProducts(pool, [(await q1<any>(pool, 'SELECT * FROM products WHERE id = ?', [productId]))]))[0].images;

catalogRouter.post('/:id/images', ...writer, rawImage, asyncHandler(async (req, res) => {
  const id = idParam(req); const d = req.auth!.userId;
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(415, 'BAD_IMAGE', 'Send a JPEG, PNG or WebP image as the request body (max 1.5 MB)');
  const mime = sniffImage(req.body);
  if (!mime) throw new AppError(415, 'BAD_IMAGE', 'That file is not a valid JPEG, PNG or WebP image');
  await assertSubscriptionActive(pool, d);
  if (!(await q1(pool, 'SELECT 1 FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [id, d]))) throw notFound('Product');
  const n = (await q1<any>(pool, 'SELECT COUNT(*) n FROM product_images WHERE product_id = ?', [id]))!.n;
  if (Number(n) >= MAX_IMAGES) throw new AppError(409, 'TOO_MANY_IMAGES', `A product can have at most ${MAX_IMAGES} photos`);
  const key = crypto.randomBytes(20).toString('hex');
  await storage.put(`${key}.${EXT[mime]}`, req.body, mime);
  await exec(pool, 'INSERT INTO product_images (product_id, distributor_id, file_key, mime, bytes, position) VALUES (?,?,?,?,?,?)', [id, d, key, mime, req.body.length, Number(n)]);
  res.status(201).json({ images: await imagesOf(id) });
}));

catalogRouter.delete('/:id/images/:imageId', ...writer, asyncHandler(async (req, res) => {
  const id = idParam(req); const img = await q1<any>(pool, 'SELECT * FROM product_images WHERE id = ? AND product_id = ? AND distributor_id = ?', [idParam(req, 'imageId'), id, req.auth!.userId]);
  if (!img) throw notFound('Photo');
  await exec(pool, 'DELETE FROM product_images WHERE id = ?', [img.id]);
  await storage.remove(`${img.file_key}.${EXT[img.mime as keyof typeof EXT]}`);
  res.json({ images: await imagesOf(id) });
}));

// Make a photo the cover (shown first in the shop).
catalogRouter.post('/:id/images/:imageId/cover', ...writer, asyncHandler(async (req, res) => {
  const id = idParam(req);
  const img = await q1<any>(pool, 'SELECT id FROM product_images WHERE id = ? AND product_id = ? AND distributor_id = ?', [idParam(req, 'imageId'), id, req.auth!.userId]);
  if (!img) throw notFound('Photo');
  await exec(pool, 'UPDATE product_images SET position = IF(id = ?, -1, position + 1) WHERE product_id = ?', [img.id, id]);
  res.json({ images: await imagesOf(id) });
}));

// ---------------------------------------------------------------------------------------------
// Batches: receive stock with a batch number and optional expiry. Orders take the earliest-expiring batch first.
// ---------------------------------------------------------------------------------------------
catalogRouter.post('/:id/batches', ...writer, asyncHandler(async (req, res) => {
  const b = z.object({
    batch_no: z.string().trim().min(1).max(60), qty: z.number().int().min(1).max(10_000_000),
    expiry_date: z.string().date().nullable().optional(),
  }).parse(req.body);
  const id = idParam(req); const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  const out = await withTx(async (c) => {
    if (!(await q1(c, 'SELECT 1 FROM products WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL FOR UPDATE', [id, d]))) throw notFound('Product');
    const r = await exec(c, 'INSERT INTO product_batches (product_id, distributor_id, batch_no, expiry_date, qty_received, qty_remaining) VALUES (?,?,?,?,?,?)', [id, d, b.batch_no, b.expiry_date ?? null, b.qty, b.qty]);
    const stock = await changeStock(c, { productId: id, distributorId: d, delta: b.qty, reason: 'manual', note: `Batch ${b.batch_no}${b.expiry_date ? ` (exp ${b.expiry_date})` : ''}`, actorId: d });
    return { batch_id: r.insertId, stock_qty: stock };
  });
  res.status(201).json(out);
}));

catalogRouter.get('/:id/batches', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const id = idParam(req);
  if (!(await q1(pool, 'SELECT 1 FROM products WHERE id = ? AND distributor_id = ?', [id, req.auth!.distributorId]))) throw notFound('Product');
  const rows = await q<any>(pool, "SELECT id, batch_no, DATE_FORMAT(expiry_date, '%Y-%m-%d') expiry_date, qty_received, qty_remaining FROM product_batches WHERE product_id = ? ORDER BY expiry_date IS NULL, expiry_date, id", [id]);
  res.json({ batches: rows.map((b) => ({ ...b, expired: !!b.expiry_date && b.expiry_date < todayUtc() })) });
}));

// Remove what is left of a batch from stock (expired, damaged). Kept in the stock history as a correction.
catalogRouter.post('/:id/batches/:batchId/write-off', ...writer, asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().max(120).default('Written off') }).parse(req.body ?? {});
  const id = idParam(req); const d = req.auth!.userId;
  const out = await withTx(async (c) => {
    const bt = await q1<any>(c, 'SELECT * FROM product_batches WHERE id = ? AND product_id = ? AND distributor_id = ? FOR UPDATE', [idParam(req, 'batchId'), id, d]);
    if (!bt) throw notFound('Batch');
    if (bt.qty_remaining <= 0) throw new AppError(409, 'EMPTY_BATCH', 'Nothing left in this batch');
    await exec(c, 'UPDATE product_batches SET qty_remaining = 0 WHERE id = ?', [bt.id]);
    const stock = await changeStock(c, { productId: id, distributorId: d, delta: -bt.qty_remaining, reason: 'correction', note: `${reason}: batch ${bt.batch_no}`, actorId: d });
    return { written_off: bt.qty_remaining, stock_qty: stock };
  });
  await audit(d, 'catalog.batch_write_off', 'product', id, out);
  res.json(out);
}));

// Soft delete keeps order history intact.
catalogRouter.delete('/:id', ...writer, asyncHandler(async (req, res) => {
  const r = await exec(pool, 'UPDATE products SET deleted_at = UTC_TIMESTAMP(), is_active = 0, sku = NULL, barcode = NULL WHERE id = ? AND distributor_id = ? AND deleted_at IS NULL', [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Product');
  await audit(req.auth!.userId, 'catalog.delete', 'product', idParam(req));
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------
// Bulk actions and import
// ---------------------------------------------------------------------------------------------
catalogRouter.post('/bulk/apply', ...writer, asyncHandler(async (req, res) => {
  const b = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(200),
    action: z.enum(['activate', 'deactivate', 'delete', 'price_percent', 'stock_add', 'set_category']),
    value: z.union([z.number(), z.string()]).optional(),
  }).parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  const affected = await withTx(async (c) => {
    const rows = await q<any>(c, 'SELECT * FROM products WHERE id IN (?) AND distributor_id = ? AND deleted_at IS NULL FOR UPDATE', [b.ids, d]);
    for (const p of rows) {
      if (b.action === 'activate' || b.action === 'deactivate') await exec(c, 'UPDATE products SET is_active = ? WHERE id = ?', [b.action === 'activate' ? 1 : 0, p.id]);
      else if (b.action === 'delete') await exec(c, 'UPDATE products SET deleted_at = UTC_TIMESTAMP(), is_active = 0, sku = NULL, barcode = NULL WHERE id = ?', [p.id]);
      else if (b.action === 'set_category') await exec(c, 'UPDATE products SET category = ? WHERE id = ?', [String(b.value ?? '').trim().slice(0, 80) || null, p.id]);
      else if (b.action === 'stock_add') {
        const delta = Number(b.value);
        if (!Number.isInteger(delta) || delta === 0) throw new AppError(400, 'VALIDATION', 'value must be a whole number');
        await changeStock(c, { productId: p.id, distributorId: d, delta, reason: 'bulk', actorId: d });
      } else if (b.action === 'price_percent') {
        const pct = Number(b.value);
        if (!Number.isFinite(pct) || pct < -90 || pct > 500) throw new AppError(400, 'VALIDATION', 'percentage must be between -90 and 500');
        const next = Math.round(Number(p.price_paise) * (1 + pct / 100));
        const nextMrp = p.mrp_paise == null ? null : Math.max(Math.round(Number(p.mrp_paise) * (1 + pct / 100)), next);
        await exec(c, 'UPDATE products SET price_paise = ?, mrp_paise = ? WHERE id = ?', [next, nextMrp, p.id]);
        // quantity breaks scale with the base price so they stay valid (always lower than it)
        await exec(c, 'UPDATE product_price_tiers SET price_paise = ROUND(price_paise * ?) WHERE product_id = ?', [1 + pct / 100, p.id]);
        await recordPrice(c, p.id, Number(p.price_paise), next, d);
      }
    }
    await audit(d, `catalog.bulk_${b.action}`, 'product', null, { ids: rows.map((r) => r.id), value: b.value ?? null }, c);
    return rows.length;
  });
  res.json({ affected });
}));

const importRow = z.object({
  name: z.string().trim().min(1).max(190),
  price: money,
  sku: optText(60), category: optText(80), brand: optText(80), unit: z.string().trim().max(20).optional(), description: optText(500),
  mrp: money.nullable().optional(),
  stock: z.coerce.number().int().min(0).max(100_000_000).optional(),
  gst: z.coerce.number().refine((v) => GST_SLABS.includes(Math.round(v * 100)), 'GST must be 0, 0.25, 3, 5, 12, 18 or 28').optional(),
  hsn: z.string().trim().regex(/^\d{4,8}$/, 'HSN is 4 to 8 digits').optional().or(z.literal('').transform(() => undefined)),
  min_order_qty: z.coerce.number().int().min(1).optional(),
  low_stock_threshold: z.coerce.number().int().min(0).optional(),
});

// Add many products at once (rows come from a spreadsheet/CSV). Valid rows are saved; invalid ones are reported by row number.
// With upsert, a row whose SKU already exists updates that product instead of creating a duplicate.
catalogRouter.post('/import/rows', ...writer, asyncHandler(async (req, res) => {
  const b = z.object({ rows: z.array(z.record(z.string(), z.any())).min(1).max(500), upsert: z.boolean().default(false), all_or_nothing: z.boolean().default(false) }).parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);

  const errors: { row: number; message: string }[] = [];
  const good: { n: number; r: z.infer<typeof importRow> }[] = [];
  b.rows.forEach((raw, i) => {
    const parsed = importRow.safeParse(raw);
    if (!parsed.success) return errors.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') });
    try {
      checkPricing(toPaise(parsed.data.price), parsed.data.mrp == null || parsed.data.mrp === '' ? null : toPaise(parsed.data.mrp), []);
    } catch (e: any) { return errors.push({ row: i + 1, message: e.message }); }
    good.push({ n: i + 1, r: parsed.data });
  });
  const seen = new Set<string>();
  const unique = good.filter(({ n, r }) => {
    if (!r.sku) return true;
    if (seen.has(r.sku)) { errors.push({ row: n, message: `sku: "${r.sku}" appears twice in this file` }); return false; }
    seen.add(r.sku); return true;
  });
  if (b.all_or_nothing && errors.length) return res.status(422).json({ created: 0, updated: 0, errors });

  let created = 0; let updated = 0;
  await withTx(async (c) => {
    for (const { n, r } of unique) {
      const price = toPaise(r.price);
      const mrp = r.mrp == null || r.mrp === '' ? null : toPaise(r.mrp);
      const gstBps = Math.round((r.gst ?? 0) * 100);
      const existing = r.sku && b.upsert ? await q1<any>(c, 'SELECT * FROM products WHERE distributor_id = ? AND sku = ? AND deleted_at IS NULL FOR UPDATE', [d, r.sku]) : undefined;
      try {
        if (existing) {
          await exec(c, `UPDATE products SET name=?, category=?, brand=?, unit=?, description=?, price_paise=?, mrp_paise=?, hsn=?, gst_rate_bps=?, min_order_qty=?, low_stock_threshold=? WHERE id=?`, [
            r.name, r.category ?? existing.category, r.brand ?? existing.brand, r.unit || existing.unit, r.description ?? existing.description, price, mrp ?? existing.mrp_paise,
            r.hsn ?? existing.hsn, r.gst === undefined ? existing.gst_rate_bps : gstBps, r.min_order_qty ?? existing.min_order_qty, r.low_stock_threshold ?? existing.low_stock_threshold, existing.id]);
          await recordPrice(c, existing.id, Number(existing.price_paise), price, d);
          if (r.stock !== undefined && r.stock !== existing.stock_qty) await changeStock(c, { productId: existing.id, distributorId: d, delta: r.stock - existing.stock_qty, reason: 'import', actorId: d });
          updated++;
        } else {
          const ins = await exec(c, `INSERT INTO products (distributor_id, name, sku, category, brand, unit, description, price_paise, mrp_paise, stock_qty, min_order_qty, low_stock_threshold, hsn, gst_rate_bps, is_active)
            VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,1)`, [d, r.name, r.sku ?? null, r.category ?? null, r.brand ?? null, r.unit || 'pcs', r.description ?? null, price, mrp, r.min_order_qty ?? 1, r.low_stock_threshold ?? 10, r.hsn ?? null, gstBps]);
          await recordPrice(c, ins.insertId, null, price, d);
          if (r.stock) await changeStock(c, { productId: ins.insertId, distributorId: d, delta: r.stock, reason: 'import', actorId: d });
          created++;
        }
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY' && String(e.message).includes('uq_prod_sku')) { errors.push({ row: n, message: `sku: "${r.sku}" already exists (turn on update-by-SKU to change it)` }); continue; }
        throw e;
      }
    }
    await audit(d, 'catalog.import', 'product', null, { created, updated, errors: errors.length }, c);
  });
  errors.sort((a, b2) => a.row - b2.row);
  res.json({ created, updated, errors });
}));
