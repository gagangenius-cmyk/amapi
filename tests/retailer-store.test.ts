import request from 'supertest';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';
import { codeFromQr, distanceKm, openNow, storeQrText } from '../src/modules/store/store.service';

const app = createApp();
let n = 0;
const phone = () => String(9300000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (p: string) => (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return login(p);
}
async function distributor() {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@c.test`, name: 'Owner', password: 'password123', business_name: 'Dist ' + p }).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string };
}

/** A retailer whose store is live: a distributor sells them a plan and the admin confirms the payment. */
async function liveRetailer(a: string, d: { token: string }, subscribe = true) {
  const plan = (await request(app).post('/api/v1/admin/retailer-plans').set(auth(a)).send({ name: 'Store ' + ++n, days: 30, price: '500', commission_new: 10 }).expect(201)).body;
  const p = phone();
  const sale = (await request(app).post('/api/v1/sales/sell').set(auth(d.token)).send({ plan_id: plan.id, retailer: { name: 'Shop Owner', phone: p, shop_name: 'Store ' + p, pincode: '400001', password: 'password123' }, method: 'cash' }).expect(201)).body;
  if (subscribe) await request(app).post(`/api/v1/admin/subscription-sales/${sale.id}/confirm`).set(auth(a)).expect(200);
  return { id: sale.retailer_id as number, phone: p, token: await login(p) };
}
const store = async (r: { token: string }) => (await request(app).get('/api/v1/store/me').set(auth(r.token)).expect(200)).body;
const addProduct = (r: { token: string }, over: object = {}) => request(app).post('/api/v1/store/products').set(auth(r.token)).send({ name: 'Item ' + ++n, price: '100', mrp: '120', cost: '80', stock_qty: 50, category: 'Grocery', ...over });
async function customer(over: object = {}) {
  const p = phone();
  const r = await request(app).post('/api/v1/customer/register').send({ name: 'Customer ' + p, phone: p, password: 'password123', address: '1 Main Road', pincode: '400001', lat: 19.07, lng: 72.87, ...over });
  return { res: r, id: r.body.id as number, token: r.body.access_token as string, phone: p };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('store codes, QR text and helpers', () => {
  it('reads the store code from the QR text, the Play Store referrer, or the bare code', () => {
    const qr = storeQrText('ABCD1234');
    expect(qr).toContain('play.google.com');
    expect(codeFromQr(qr)).toBe('ABCD1234');
    expect(codeFromQr('aayme_store=abcd1234')).toBe('ABCD1234');
    expect(codeFromQr('AYS-ABCD1234')).toBe('ABCD1234');
    expect(codeFromQr('ABCD1234')).toBe('ABCD1234');
    expect(codeFromQr('hello world')).toBeNull();
  });
  it('measures distance, and knows when a store is open (including past midnight)', () => {
    expect(distanceKm(19.07, 72.87, 19.07, 72.87)).toBe(0);
    expect(distanceKm(19.07, 72.87, 19.17, 72.87)).toBeGreaterThan(10);
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 14, h - 5, m - 30));          // that clock time in India
    expect(openNow({ open_override: null, opens_at: '09:00', closes_at: '21:00' }, at(10))).toBe(true);
    expect(openNow({ open_override: null, opens_at: '09:00', closes_at: '21:00' }, at(22))).toBe(false);
    expect(openNow({ open_override: null, opens_at: '18:00', closes_at: '02:00' }, at(1))).toBe(true);
    expect(openNow({ open_override: 0, opens_at: '09:00', closes_at: '21:00' }, at(10))).toBe(false);
    expect(openNow({ open_override: null, opens_at: null, closes_at: null }, at(3))).toBe(true);
  });
});

describe('the retailer’s store', () => {
  it('can be set up at once, but only sells once the AAYME subscription is active', async () => {
    const a = await admin(); const d = await distributor();
    const r = await liveRetailer(a, d, false);
    const me = await store(r);
    expect(me.live).toBe(false);
    expect(me.store_code).toMatch(/^[A-F0-9]{8}$/);
    expect(me.qr_text).toContain(`aayme_store%3D${me.store_code}`);
    const blocked = await addProduct(r);
    expect(blocked.status).toBe(402); expect(blocked.body.error.code).toBe('STORE_NOT_ACTIVE');

    const sale = (await q1<any>(pool, 'SELECT id FROM subscription_sales WHERE retailer_id = ?', [r.id]))!;
    await request(app).post(`/api/v1/admin/subscription-sales/${sale.id}/confirm`).set(auth(a)).expect(200);
    expect((await store(r)).live).toBe(true);
    expect((await addProduct(r)).status).toBe(201);
  });

  it('keeps products: price rules, barcode lookup, hiding, deleting', async () => {
    const a = await admin(); const d = await distributor(); const r = await liveRetailer(a, d);
    const p = (await addProduct(r, { name: 'Tea 250g', barcode: '8901234567890', price: '150', mrp: '180' }).expect(201)).body;
    expect(p).toMatchObject({ name: 'Tea 250g', price: '150.00', mrp: '180.00', discount_pct: 17, stock_qty: 50 });
    expect((await addProduct(r, { price: '100', mrp: '90' })).body.error.code).toBe('BAD_MRP');
    expect((await addProduct(r, { barcode: '8901234567890' })).body.error.code).toBe('BARCODE_TAKEN');
    expect((await request(app).get('/api/v1/store/products/by-barcode/8901234567890').set(auth(r.token)).expect(200)).body.name).toBe('Tea 250g');
    expect((await request(app).get('/api/v1/store/products/by-barcode/0000000000').set(auth(r.token))).status).toBe(404);
    await request(app).put(`/api/v1/store/products/${p.id}`).set(auth(r.token)).send({ price: '160', stock_qty: 3 }).expect(200);
    const list = (await request(app).get('/api/v1/store/products').query({ status: 'low' }).set(auth(r.token)).expect(200)).body;
    expect(list.products.map((x: any) => x.id)).toContain(p.id);
    await request(app).delete(`/api/v1/store/products/${p.id}`).set(auth(r.token)).expect(204);
    expect((await request(app).get('/api/v1/store/products').set(auth(r.token))).body.products.some((x: any) => x.id === p.id)).toBe(false);
  });

  it('copies products from a distributor’s catalogue, costed at what the retailer pays, with a markup', async () => {
    const a = await admin(); const d = await distributor(); const r = await liveRetailer(a, d);
    const dp = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice 5kg', price: '400', mrp: '500', gst_rate_bps: 500, stock_qty: 100, category: 'Grain' }).expect(201)).body;
    const list = (await request(app).get('/api/v1/store/distributor-products').query({ distributor_id: d.id }).set(auth(r.token)).expect(200)).body.products;
    expect(list.find((x: any) => x.id === dp.id)).toMatchObject({ your_cost: '420.00', already_in_store: false });          // 400 + 5% GST

    const imp = (await request(app).post('/api/v1/store/products/import').set(auth(r.token)).send({ distributor_id: d.id, product_ids: [dp.id], markup_percent: 10, stock_qty: 7 }).expect(201)).body;
    expect(imp.added).toBe(1);
    const mine = (await request(app).get('/api/v1/store/products').set(auth(r.token))).body.products.find((x: any) => x.name === 'Rice 5kg');
    expect(mine).toMatchObject({ cost: '420.00', price: '462.00', stock_qty: 7, imported: true });
    expect((await request(app).post('/api/v1/store/products/import').set(auth(r.token)).send({ distributor_id: d.id, product_ids: [dp.id] }).expect(201)).body.skipped[0].reason).toMatch(/already/);

    const other = await distributor();
    expect((await request(app).get('/api/v1/store/distributor-products').query({ distributor_id: other.id }).set(auth(r.token))).status).toBe(404);   // not their distributor
  });
});

describe('customers and the store QR', () => {
  it('a new customer who comes from a store QR joins that store and has it pinned first', async () => {
    const a = await admin(); const d = await distributor(); const r1 = await liveRetailer(a, d); const r2 = await liveRetailer(a, d);
    const s1 = await store(r1); const s2 = await store(r2);
    await request(app).put('/api/v1/store/me').set(auth(r1.token)).send({ lat: 19.071, lng: 72.871 }).expect(200);
    await request(app).put('/api/v1/store/me').set(auth(r2.token)).send({ lat: 19.075, lng: 72.875 }).expect(200);

    const c = await customer({ store_code: s2.qr_text });                                  // the QR text, as the Play Store referrer would carry it
    expect(c.res.status).toBe(201);
    expect(c.res.body.pinned_store).toMatchObject({ id: r2.id, code: s2.store_code });

    const mine = (await request(app).get('/api/v1/store/customers').set(auth(r2.token)).expect(200)).body.customers;
    expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ phone: c.phone, source: 'qr', has_app: true });
    expect((await request(app).get('/api/v1/store/customers').set(auth(r1.token))).body.customers).toHaveLength(0);

    const home = (await request(app).get('/api/v1/customer/home').set(auth(c.token)).expect(200)).body;
    expect(home.pinned_store.id).toBe(r2.id);                                            // on top, even though the other store is nearer
    expect(home.nearby_stores.map((x: any) => x.id)).toContain(r1.id);
    expect(home.nearby_stores.map((x: any) => x.id)).not.toContain(r2.id);               // not listed twice

    // next time, scanning any other store's QR opens that store and adds them there too; the pin stays
    const scan = (await request(app).post('/api/v1/customer/scan').set(auth(c.token)).send({ code: s1.qr_text }).expect(200)).body;
    expect(scan).toMatchObject({ joined: true, store: { id: r1.id } });
    expect((await request(app).post('/api/v1/customer/scan').set(auth(c.token)).send({ code: s1.store_code }).expect(200)).body.joined).toBe(false);
    expect((await request(app).get('/api/v1/customer/home').set(auth(c.token))).body.pinned_store.id).toBe(r2.id);
    expect((await request(app).get('/api/v1/store/customers').set(auth(r1.token))).body.customers).toHaveLength(1);
    expect((await request(app).post('/api/v1/customer/scan').set(auth(c.token)).send({ code: 'not a store' })).status).toBe(400);
  });

  it('signs up without a QR, refuses a repeated phone, and a customer cannot use retailer tools', async () => {
    const c = await customer();
    expect(c.res.status).toBe(201); expect(c.res.body.pinned_store).toBeNull();
    expect((await customer({ phone: c.phone })).res.status).toBe(409);
    expect((await request(app).get('/api/v1/store/me').set(auth(c.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/sales/plans').set(auth(c.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/customer/home')).status).toBe(401);
    const login2 = await request(app).post('/api/v1/auth/login').send({ phone: c.phone, password: 'password123' });
    expect(login2.status).toBe(200); expect(login2.body.role).toBe('customer');
  });

  it('shows only live stores, with the store’s own products, and the public QR page', async () => {
    const a = await admin(); const d = await distributor(); const live = await liveRetailer(a, d); const dormant = await liveRetailer(a, d, false);
    const s = await store(live); await store(dormant);
    const p = (await addProduct(live, { name: 'Unique Biscuit' }).expect(201)).body;
    const c = await customer();
    const stores = (await request(app).get('/api/v1/customer/stores').set(auth(c.token)).expect(200)).body.stores.map((x: any) => x.id);
    expect(stores).toContain(live.id); expect(stores).not.toContain(dormant.id);
    expect((await request(app).get(`/api/v1/customer/stores/${dormant.id}`).set(auth(c.token))).status).toBe(404);
    const found = (await request(app).get('/api/v1/customer/search').query({ q: 'Unique Biscuit' }).set(auth(c.token)).expect(200)).body;
    expect(found.products.map((x: any) => x.id)).toContain(p.id);
    expect((await request(app).get(`/api/v1/customer/stores/${live.id}/products`).set(auth(c.token))).body.products.some((x: any) => x.id === p.id && x.stock_qty === 20)).toBe(true);   // exact stock hidden
    const pub = (await request(app).get(`/api/v1/public/store/${s.store_code}`).expect(200)).body;
    expect(pub.store.name).toBeTruthy(); expect(pub.get_the_app).toContain('referrer=');
  });
});

describe('online orders', () => {
  async function setup(over: object = {}) {
    const a = await admin(); const d = await distributor(); const r = await liveRetailer(a, d);
    await request(app).put('/api/v1/store/me').set(auth(r.token)).send({ delivery_fee: '30', free_delivery_above: '500', min_order: '100', upi_id: 'shop@okaxis', upi_payee: 'The Shop', ...over }).expect(200);
    const p = (await addProduct(r, { name: 'Soap', price: '60', cost: '40', stock_qty: 10 }).expect(201)).body;
    const c = await customer();
    return { r, p, c };
  }
  const order = (c: { token: string }, r: { id: number }, items: object[], over: object = {}) => request(app).post('/api/v1/customer/orders').set(auth(c.token)).send({ retailer_id: r.id, items, payment_method: 'cod', address: '12 Park Street', ...over });

  it('is placed, held against stock, accepted, delivered and paid, with notifications to both sides', async () => {
    const { r, p, c } = await setup();
    const o = (await order(c, r, [{ product_id: p.id, qty: 3 }]).expect(201)).body;
    expect(o).toMatchObject({ total: '210.00' });                                       // 180 + ₹30 delivery
    expect((await q1<any>(pool, 'SELECT stock_qty FROM store_products WHERE id = ?', [p.id]))!.stock_qty).toBe(7);

    const fresh = (await request(app).get('/api/v1/store/orders').query({ status: 'open' }).set(auth(r.token)).expect(200)).body.orders;
    expect(fresh[0]).toMatchObject({ id: o.id, status: 'placed', payment_status: 'pending', customer_name: expect.any(String) });
    expect((await request(app).get('/api/v1/store/dashboard').set(auth(r.token))).body).toMatchObject({ new_orders: 1, total_customers: 1 });

    await request(app).post(`/api/v1/store/orders/${o.id}/transition`).set(auth(r.token)).send({ to: 'accepted' }).expect(200);
    expect((await request(app).post(`/api/v1/store/orders/${o.id}/transition`).set(auth(r.token)).send({ to: 'placed' as any })).status).toBe(400);
    expect((await request(app).post(`/api/v1/customer/orders/${o.id}/cancel`).set(auth(c.token))).status).toBe(409);   // too late once accepted
    await request(app).post(`/api/v1/store/orders/${o.id}/transition`).set(auth(r.token)).send({ to: 'out_for_delivery' }).expect(200);
    await request(app).post(`/api/v1/store/orders/${o.id}/transition`).set(auth(r.token)).send({ to: 'delivered' }).expect(200);

    const mine = (await request(app).get(`/api/v1/customer/orders/${o.id}`).set(auth(c.token)).expect(200)).body;
    expect(mine).toMatchObject({ status: 'delivered', payment_status: 'paid', total: '210.00' });          // cash on delivery is paid on delivery
    expect(mine.items[0]).toMatchObject({ name: 'Soap', qty: 3, line_total: '180.00' });
    const dash = (await request(app).get('/api/v1/store/dashboard').set(auth(r.token))).body;
    expect(dash).toMatchObject({ total_sales: '210.00', earnings: '60.00', new_orders: 0 });               // earnings = (60 - 40) x 3
  });

  it('is free to deliver above the limit, can be cancelled before acceptance (stock returns), and pays by UPI', async () => {
    const { r, p, c } = await setup();
    const big = (await order(c, r, [{ product_id: p.id, qty: 9 }], { payment_method: 'upi' }).expect(201)).body;
    expect(big.total).toBe('540.00');                                                   // free delivery above ₹500
    expect(big.upi_link).toMatch(/^upi:\/\/pay\?.*pa=shop%40okaxis/);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM store_products WHERE id = ?', [p.id]))!.stock_qty).toBe(1);
    await request(app).post(`/api/v1/customer/orders/${big.id}/cancel`).set(auth(c.token)).expect(200);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM store_products WHERE id = ?', [p.id]))!.stock_qty).toBe(10);
    await request(app).post(`/api/v1/store/orders/${big.id}/transition`).set(auth(r.token)).send({ to: 'accepted' }).expect(409);   // already cancelled
  });

  it('refuses a closed store, an order below the minimum, more than the stock, and payment ways the store does not take', async () => {
    const { r, p, c } = await setup();
    expect((await order(c, r, [{ product_id: p.id, qty: 1 }])).body.error.code).toBe('BELOW_MINIMUM');          // ₹60 < ₹100
    expect((await order(c, r, [{ product_id: p.id, qty: 99 }])).body.error.code).toBe('OUT_OF_STOCK');
    await request(app).put('/api/v1/store/me').set(auth(r.token)).send({ accepts_cod: false }).expect(200);
    expect((await order(c, r, [{ product_id: p.id, qty: 3 }])).body.error.code).toBe('COD_OFF');
    await request(app).put('/api/v1/store/me').set(auth(r.token)).send({ accepts_cod: true, open_override: 0 }).expect(200);
    expect((await order(c, r, [{ product_id: p.id, qty: 3 }])).body.error.code).toBe('STORE_CLOSED');
    await request(app).put('/api/v1/store/me').set(auth(r.token)).send({ open_override: 1, upi_id: null }).expect(200);
    expect((await order(c, r, [{ product_id: p.id, qty: 3 }], { payment_method: 'upi' })).body.error.code).toBe('UPI_OFF');
  });
});

describe('counter billing and the day book', () => {
  it('bills scanned items, takes the payment, makes a UPI QR for the retailer’s own account, and totals the day', async () => {
    const a = await admin(); const d = await distributor(); const r = await liveRetailer(a, d);
    await request(app).put('/api/v1/store/me').set(auth(r.token)).send({ upi_id: 'counter@okicici', upi_payee: 'Counter Shop' }).expect(200);
    const biscuit = (await addProduct(r, { name: 'Biscuit', barcode: '1111111111', price: '10', cost: '7', stock_qty: 100 }).expect(201)).body;
    const oil = (await addProduct(r, { name: 'Oil', barcode: '2222222222', price: '150', mrp: '160', cost: '120', stock_qty: 5 }).expect(201)).body;

    const first = await request(app).post('/api/v1/store/pos/bills').set(auth(r.token)).send({ items: [{ barcode: '1111111111', qty: 3 }, { barcode: '2222222222', qty: 1 }], payment_mode: 'upi', customer_phone: phone(), customer_name: 'Walk In' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const b1 = first.body;
    expect(b1).toMatchObject({ channel: 'counter', status: 'delivered', payment_method: 'upi', subtotal: '180.00', total: '180.00' });
    expect(b1.bill_no).toMatch(/^B\d+-00001$/);
    expect(b1.upi_link).toMatch(/^upi:\/\/pay\?.*pa=counter%40okicici.*am=180\.00/);
    expect(b1.store.name).toBeTruthy();

    const b2 = (await request(app).post('/api/v1/store/pos/bills').set(auth(r.token)).send({ items: [{ product_id: oil.id, qty: 2 }], payment_mode: 'cash', discount: '20' }).expect(201)).body;
    expect(b2).toMatchObject({ subtotal: '300.00', discount: '20.00', total: '280.00' });
    expect(b2.bill_no).toMatch(/-00002$/);
    const b3 = (await request(app).post('/api/v1/store/pos/bills').set(auth(r.token)).send({ items: [{ barcode: '1111111111', qty: 5 }], payment_mode: 'card' }).expect(201)).body;

    expect((await q1<any>(pool, 'SELECT stock_qty FROM store_products WHERE id = ?', [oil.id]))!.stock_qty).toBe(2);
    expect((await request(app).post('/api/v1/store/pos/bills').set(auth(r.token)).send({ items: [{ product_id: oil.id, qty: 3 }], payment_mode: 'cash' })).body.error.code).toBe('OUT_OF_STOCK');
    expect((await request(app).post('/api/v1/store/pos/bills').set(auth(r.token)).send({ items: [{ barcode: '9999999999', qty: 1 }], payment_mode: 'cash' })).body.error.code).toBe('PRODUCT_NOT_FOUND');
    expect((await request(app).get('/api/v1/store/customers').set(auth(r.token))).body.customers.some((c: any) => c.source === 'counter')).toBe(true);

    let book = (await request(app).get('/api/v1/store/daybook').set(auth(r.token)).expect(200)).body;
    expect(book).toMatchObject({ bills: 3, total_sales: '510.00', collected: '510.00', pending: '0.00', cancelled: 0 });     // 180 + 280 + 50
    expect(book.by_mode).toMatchObject({ upi: { amount: '180.00', count: 1 }, cash: { amount: '280.00', count: 1 }, card: { amount: '50.00', count: 1 }, cod: { amount: '0.00', count: 0 } });

    await request(app).post(`/api/v1/store/pos/bills/${b3.id}/cancel`).set(auth(r.token)).expect(200);       // a mistake: the stock returns and the day's total drops
    expect((await request(app).post(`/api/v1/store/pos/bills/${b3.id}/cancel`).set(auth(r.token))).status).toBe(409);
    book = (await request(app).get('/api/v1/store/daybook').set(auth(r.token))).body;
    expect(book).toMatchObject({ bills: 2, total_sales: '460.00', cancelled: 1 });

    const again = (await request(app).get(`/api/v1/store/pos/bills/${b1.id}`).set(auth(r.token)).expect(200)).body;
    expect(again.items).toHaveLength(2);
    const rep = (await request(app).get('/api/v1/store/reports/sales').set(auth(r.token)).expect(200)).body;
    expect(rep.by_channel[0]).toMatchObject({ channel: 'counter', orders: 2, total: '460.00' });
    expect(rep.top_products[0].name).toBe('Oil');
  });

  it('keeps one retailer’s bills and products away from another', async () => {
    const a = await admin(); const d = await distributor(); const r1 = await liveRetailer(a, d); const r2 = await liveRetailer(a, d);
    const p = (await addProduct(r1, { barcode: '3333333333' }).expect(201)).body;
    expect((await request(app).post('/api/v1/store/pos/bills').set(auth(r2.token)).send({ items: [{ product_id: p.id, qty: 1 }], payment_mode: 'cash' })).status).toBe(404);
    expect((await request(app).get('/api/v1/store/products/by-barcode/3333333333').set(auth(r2.token))).status).toBe(404);
    const bill = (await request(app).post('/api/v1/store/pos/bills').set(auth(r1.token)).send({ items: [{ product_id: p.id, qty: 1 }], payment_mode: 'cash' }).expect(201)).body;
    expect((await request(app).get(`/api/v1/store/pos/bills/${bill.id}`).set(auth(r2.token))).status).toBe(404);
    expect((await request(app).post(`/api/v1/store/pos/bills/${bill.id}/cancel`).set(auth(r2.token))).status).toBe(404);
  });

  it('runs offers that customers see as banners', async () => {
    const a = await admin(); const d = await distributor(); const r = await liveRetailer(a, d);
    const o = (await request(app).post('/api/v1/store/offers').set(auth(r.token)).send({ title: 'Diwali sale', description: '10% off on all items' }).expect(201)).body;
    const c = await customer({ store_code: (await store(r)).store_code });
    expect((await request(app).get('/api/v1/customer/home').set(auth(c.token))).body.banners.map((x: any) => x.title)).toContain('Diwali sale');
    await request(app).put(`/api/v1/store/offers/${o.id}`).set(auth(r.token)).send({ is_active: false }).expect(200);
    expect((await request(app).get('/api/v1/customer/home').set(auth(c.token))).body.banners.map((x: any) => x.title)).not.toContain('Diwali sale');
  });
});
