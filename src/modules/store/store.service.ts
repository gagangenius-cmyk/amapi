import crypto from 'crypto';
import { Conn, exec, pool, q1 } from '../../db/pool';
import { fromPaise } from '../../utils/money';
import { currentSubscription } from '../retailerSales/retailerSales.routes';

export const PLAY_STORE_URL = process.env.PLAY_STORE_URL ?? 'https://play.google.com/store/apps/details?id=com.aayme.b2b';

export const money = (v: unknown) => fromPaise(Number(v ?? 0));

/** The text inside a store's QR code: the Play Store page of the AAYME app, carrying the store code so a new install can join that store. */
export const storeQrText = (code: string) => `${PLAY_STORE_URL}${PLAY_STORE_URL.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(`aayme_store=${code}`)}`;

/** What a QR (or an install referrer) says: the store code, if it is one of ours. */
export function codeFromQr(text: string): string | null {
  const t = String(text ?? '').trim();
  const m = t.match(/aayme_store(?:=|%3D)([A-Za-z0-9]{4,12})/i) ?? t.match(/^AYS-([A-Za-z0-9]{4,12})$/i) ?? (/^[A-Za-z0-9]{6,12}$/.test(t) ? [t, t] : null);
  return m ? m[1].toUpperCase() : null;
}

/** The retailer's store, created on first use from their shop profile. */
export async function ensureStore(c: Conn, retailerId: number) {
  let s = await q1<any>(c, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [retailerId]);
  if (s) return s;
  const p = await q1<any>(c, 'SELECT u.phone, rp.shop_name, rp.address, rp.pincode FROM users u JOIN retailer_profiles rp ON rp.user_id = u.id WHERE u.id = ?', [retailerId]);
  if (!p) return null;
  const loc = await q1<any>(c, 'SELECT lat, lng FROM retailer_profiles WHERE user_id = ?', [retailerId]).catch(() => null);
  for (let tries = 0; tries < 5; tries++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    try {
      await exec(c, 'INSERT INTO retailer_stores (retailer_id, code, name, phone, address, pincode, lat, lng) VALUES (?,?,?,?,?,?,?,?)', [retailerId, code, p.shop_name, p.phone, p.address, p.pincode, loc?.lat ?? null, loc?.lng ?? null]);
      break;
    } catch (e: any) { if (e?.code !== 'ER_DUP_ENTRY' || String(e.message).includes('PRIMARY')) throw e; }
  }
  s = await q1<any>(c, 'SELECT * FROM retailer_stores WHERE retailer_id = ?', [retailerId]);
  return s;
}

/** A store is live while its retailer holds an active AAYME subscription and has not switched it off. */
export async function storeLive(c: Conn, store: { retailer_id: number; is_active: number }): Promise<boolean> {
  if (!store.is_active) return false;
  return !!(await currentSubscription(c, store.retailer_id));
}

/** Open now: the manual switch if set, else the opening hours (Indian time); a store with no hours set counts as open. */
export function openNow(s: { open_override: number | null; opens_at: string | null; closes_at: string | null }, now = new Date()): boolean {
  if (s.open_override === 1) return true;
  if (s.open_override === 0) return false;
  if (!s.opens_at || !s.closes_at) return true;
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const cur = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const mins = (t: string) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const a = mins(s.opens_at); const b = mins(s.closes_at);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;     // a store that closes after midnight
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180; const R = 6371;
  const dLat = rad(lat2 - lat1); const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/** How a store looks to a customer (never the UPI id's owner details beyond what is needed to pay, and never the retailer's cost). */
export function presentStore(s: any, opts: { distance?: number | null; live?: boolean } = {}) {
  return {
    id: s.retailer_id, code: s.code, name: s.name, description: s.description, phone: s.phone, address: s.address, pincode: s.pincode,
    lat: s.lat == null ? null : Number(s.lat), lng: s.lng == null ? null : Number(s.lng),
    whatsapp_url: s.whatsapp_url, facebook_url: s.facebook_url, instagram_url: s.instagram_url, youtube_url: s.youtube_url,
    open_now: openNow(s), opens_at: s.opens_at ? String(s.opens_at).slice(0, 5) : null, closes_at: s.closes_at ? String(s.closes_at).slice(0, 5) : null,
    delivery_enabled: !!s.delivery_enabled, delivery_fee: money(s.delivery_fee_paise), free_delivery_above: s.free_delivery_above_paise == null ? null : money(s.free_delivery_above_paise),
    min_order: money(s.min_order_paise), delivery_minutes: s.delivery_minutes_min ? { min: s.delivery_minutes_min, max: s.delivery_minutes_max ?? s.delivery_minutes_min } : null,
    accepts_cod: !!s.accepts_cod, accepts_upi: !!s.accepts_upi && !!s.upi_id,
    ...(opts.distance !== undefined ? { distance_km: opts.distance } : {}), ...(opts.live !== undefined ? { live: opts.live } : {}),
  };
}

export const presentProduct = (p: any) => ({
  id: p.id, name: p.name, description: p.description, brand: p.brand, category: p.category, unit: p.unit, barcode: p.barcode, sku: p.sku,
  price: money(p.price_paise), mrp: p.mrp_paise == null ? null : money(p.mrp_paise), gst_rate_bps: p.gst_rate_bps,
  discount_pct: p.mrp_paise && Number(p.mrp_paise) > Number(p.price_paise) ? Math.round(((Number(p.mrp_paise) - Number(p.price_paise)) / Number(p.mrp_paise)) * 100) : 0,
  stock_qty: Number(p.stock_qty), in_stock: Number(p.stock_qty) > 0, image_url: p.image_url, is_active: !!p.is_active, imported: !!p.source_product_id,
});

export const presentOrder = (o: any, items?: any[]) => ({
  id: o.id, retailer_id: o.retailer_id, channel: o.channel, bill_no: o.bill_no, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status,
  subtotal: money(o.subtotal_paise), delivery_fee: money(o.delivery_fee_paise), discount: money(o.discount_paise), total: money(o.total_paise),
  customer_id: o.customer_id, customer_name: o.customer_name, customer_phone: o.customer_phone, delivery_address: o.delivery_address, note: o.note, upi_ref: o.upi_ref,
  created_at: o.created_at, store_name: o.store_name ?? undefined, item_count: o.item_count == null ? undefined : Number(o.item_count),
  ...(items ? { items: items.map((i) => ({ id: i.id, product_id: i.product_id, name: i.name, unit: i.unit, qty: i.qty, unit_price: money(i.unit_price_paise), line_total: money(i.line_total_paise) })) } : {}),
});

/** Adds the person to a store's customer list (once per phone number); returns the row. */
export async function addStoreCustomer(c: Conn, retailerId: number, p: { name: string; phone: string; customerId?: number | null; source: 'qr' | 'online' | 'counter' | 'manual' }) {
  await exec(c, `INSERT INTO store_customers (retailer_id, customer_id, name, phone, source) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE customer_id = COALESCE(customer_id, VALUES(customer_id)), name = IF(name = '' , VALUES(name), name)`, [retailerId, p.customerId ?? null, p.name, p.phone, p.source]);
  return q1<any>(c, 'SELECT * FROM store_customers WHERE retailer_id = ? AND phone = ?', [retailerId, p.phone]);
}

export const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export { pool };
