import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool, q, q1 } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(4000000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@c.test`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@c.test`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
async function link(d: { token: string; id: number }, r: { token: string; phone: string }) {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
}
const add = (token: string, body: object) => request(app).post('/api/v1/catalog').set(auth(token)).send({ name: 'Item', price: '100', ...body });

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('product details and validation', () => {
  it('stores the full product record and reports derived fields', async () => {
    const d = await reg('distributor');
    const r = await add(d.token, { name: 'Basmati Rice 25kg', sku: 'RICE-25', category: 'Grains', brand: 'Royal', unit: 'bag', description: 'Aged basmati', price: '2400', mrp: '3000', stock_qty: 40, hsn: '1006', gst_rate_bps: 500, min_order_qty: 2, low_stock_threshold: 10, tiers: [{ min_qty: 10, price: '2300' }, { min_qty: 50, price: '2200' }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sku: 'RICE-25', category: 'Grains', brand: 'Royal', unit: 'bag', price: '2400.00', mrp: '3000.00', discount_pct: 20, stock_qty: 40, stock_status: 'ok', min_order_qty: 2 });
    expect(r.body.tiers).toEqual([{ min_qty: 10, price: '2300.00' }, { min_qty: 50, price: '2200.00' }]);
  });

  it('rejects impossible combinations', async () => {
    const d = await reg('distributor');
    expect((await add(d.token, { price: '100', mrp: '90' })).body.error.code).toBe('BAD_MRP');
    expect((await add(d.token, { price: '100', tiers: [{ min_qty: 10, price: '100' }] })).body.error.code).toBe('BAD_TIER'); // not cheaper
    expect((await add(d.token, { price: '100', tiers: [{ min_qty: 10, price: '90' }, { min_qty: 20, price: '95' }] })).body.error.code).toBe('BAD_TIER'); // gets dearer
    expect((await add(d.token, { price: '100', tiers: [{ min_qty: 10, price: '90' }, { min_qty: 10, price: '80' }] })).status).toBe(400);
    expect((await add(d.token, { gst_rate_bps: 700 })).status).toBe(400);   // not a real GST slab
    expect((await add(d.token, { hsn: 'abc' })).status).toBe(400);
    expect((await add(d.token, { price: '-5' })).status).toBe(400);
    expect((await add(d.token, { stock_qty: -1 })).status).toBe(400);
  });

  it('keeps SKUs unique per distributor, and lets a deleted SKU be reused', async () => {
    const a = await reg('distributor'); const b = await reg('distributor');
    const first = (await add(a.token, { sku: 'X1' })).body;
    expect((await add(a.token, { sku: 'X1' })).body.error.code).toBe('SKU_TAKEN');
    expect((await add(b.token, { sku: 'X1' })).status).toBe(201); // different distributor: fine
    await request(app).delete(`/api/v1/catalog/${first.id}`).set(auth(a.token)).expect(204);
    expect((await add(a.token, { sku: 'X1' })).status).toBe(201);
  });
});

describe('browsing the catalog', () => {
  it('searches, filters, pages and summarises', async () => {
    const d = await reg('distributor');
    await add(d.token, { name: 'Tata Salt', category: 'Staples', brand: 'Tata', sku: 'S1', stock_qty: 100 });
    await add(d.token, { name: 'Aashirvaad Atta', category: 'Staples', brand: 'ITC', sku: 'A1', stock_qty: 5, low_stock_threshold: 10 });
    await add(d.token, { name: 'Parle-G', category: 'Biscuits', brand: 'Parle', sku: 'P1', stock_qty: 0 });
    await add(d.token, { name: 'Hidden thing', category: 'Biscuits', is_active: false, stock_qty: 50 });
    const get = (qs: string) => request(app).get(`/api/v1/catalog?${qs}`).set(auth(d.token)).expect(200).then((r) => r.body);

    const all = await get('');
    expect(all.total).toBe(4);
    expect(all.summary).toEqual({ total: 4, active: 3, hidden: 1, out_of_stock: 1, low_stock: 1 });
    expect(all.categories).toEqual([{ name: 'Biscuits', count: 2 }, { name: 'Staples', count: 2 }]);
    expect((await get('q=tata')).products.map((p: any) => p.name)).toEqual(['Tata Salt']);        // by name or brand
    expect((await get('q=ITC')).products.map((p: any) => p.name)).toEqual(['Aashirvaad Atta']);
    expect((await get('q=P1')).products.map((p: any) => p.name)).toEqual(['Parle-G']);             // by SKU
    expect((await get('category=Biscuits')).total).toBe(2);
    expect((await get('status=low')).products.map((p: any) => p.name)).toEqual(['Aashirvaad Atta']);
    expect((await get('status=out')).products.map((p: any) => p.name)).toEqual(['Parle-G']);
    expect((await get('status=hidden')).products.map((p: any) => p.name)).toEqual(['Hidden thing']);
    const page = await get('limit=2&offset=2');
    expect(page.products).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it('is private to its distributor and read-only for staff', async () => {
    const a = await reg('distributor'); const b = await reg('distributor');
    const p = (await add(a.token, { stock_qty: 5 })).body;
    await request(app).get(`/api/v1/catalog/${p.id}`).set(auth(b.token)).expect(404);
    await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(b.token)).send({ name: 'hijack' }).expect(404);
    await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(b.token)).send({ delta: 5 }).expect(404);
    await request(app).delete(`/api/v1/catalog/${p.id}`).set(auth(b.token)).expect(404);
    const ep = phone();
    await request(app).post('/api/v1/distributor/employees').set(auth(a.token)).send({ phone: ep, name: 'Agent', password: 'password123' }).expect(201);
    const eTok = (await request(app).post('/api/v1/auth/login').send({ phone: ep, password: 'password123' })).body.access_token;
    await request(app).get('/api/v1/catalog').set(auth(eTok)).expect(200);
    await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(eTok)).send({ name: 'x' }).expect(403);
    await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(eTok)).send({ delta: 1 }).expect(403);
  });
});

describe('stock is safe against stale screens', () => {
  it('adjusts by amount, refuses to go negative, and logs every movement', async () => {
    const d = await reg('distributor');
    const p = (await add(d.token, { stock_qty: 10 })).body;
    expect((await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ delta: 5, note: 'new delivery' })).body.stock_qty).toBe(15);
    expect((await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ delta: -3 })).body.stock_qty).toBe(12);
    const neg = await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ delta: -50 });
    expect(neg.status).toBe(409);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [p.id]))!.stock_qty).toBe(12);
    const hist = (await request(app).get(`/api/v1/catalog/${p.id}`).set(auth(d.token))).body.stock_history;
    expect(hist.map((h: any) => [h.delta, h.balance_after, h.reason])).toEqual([[-3, 12, 'manual'], [5, 15, 'manual'], [10, 10, 'initial']]);
    expect(hist[1].note).toBe('new delivery');
  });

  it('a screen that is out of date can no longer wipe out sales (the original bug)', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const p = (await add(d.token, { stock_qty: 10 })).body;
    const screenShowed = 10;
    const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'k').send({ distributor_id: d.id, items: [{ product_id: p.id, qty: 4 }] })).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200); // real stock is now 6

    // the old way (absolute number from a stale screen) is gone
    expect((await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ stock_qty: screenShowed + 10 })).body.error.code).toBe('USE_STOCK_ENDPOINT');
    // "+10" now adds to whatever is really there
    expect((await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ delta: 10 })).body.stock_qty).toBe(16);
    // a stock COUNT is only applied if nothing moved since it was looked at
    const stale = await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ set_to: 20, expected: screenShowed });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STOCK_CHANGED');
    expect(stale.body.error.details.current).toBe(16);
    expect((await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ set_to: 18, expected: 16, note: 'counted' })).body.stock_qty).toBe(18);
    const hist = (await request(app).get(`/api/v1/catalog/${p.id}`).set(auth(d.token))).body.stock_history;
    expect(hist.map((h: any) => h.reason)).toEqual(['correction', 'manual', 'order_accepted', 'initial']);
  });

  it('records order acceptance and cancellation in the stock history', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const p = (await add(d.token, { stock_qty: 10 })).body;
    const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'k2').send({ distributor_id: d.id, items: [{ product_id: p.id, qty: 3 }] })).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' });
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'cancelled' });
    const rows = await q<any>(pool, 'SELECT delta, reason, ref_order_id FROM stock_movements WHERE product_id = ? ORDER BY id', [p.id]);
    expect(rows.map((x) => [x.delta, x.reason, x.ref_order_id])).toEqual([[10, 'initial', null], [-3, 'order_accepted', oid], [3, 'order_cancelled', oid]]);
  });
});

describe('editing, prices and quantity breaks', () => {
  it('edits details, tracks price history and applies quantity breaks and minimums to real orders', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const p = (await add(d.token, { name: 'Oil 1L', price: '100', stock_qty: 500, gst_rate_bps: 0, min_order_qty: 3, tiers: [{ min_qty: 10, price: '90' }, { min_qty: 50, price: '80' }] })).body;
    const buy = (qty: number, key: string) => request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', key).send({ distributor_id: d.id, items: [{ product_id: p.id, qty }] });

    expect((await buy(2, 'a')).body.error.code).toBe('MIN_QTY');
    expect((await buy(3, 'b')).body.order.total).toBe('300.00');   // base price
    expect((await buy(10, 'c')).body.order.total).toBe('900.00');  // 10 x 90
    expect((await buy(49, 'd')).body.order.total).toBe('4410.00'); // 49 x 90
    expect((await buy(50, 'e')).body.order.total).toBe('4000.00'); // 50 x 80
    const items = (await request(app).get(`/api/v1/orders/${(await buy(50, 'e')).body.order.id}`).set(auth(r.token))).body.items;
    expect(items[0]).toMatchObject({ qty: 50, unit_price: '80.00' });

    // edit: price goes up, tiers replaced; history keeps both prices; stock is untouched
    const edited = await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ price: '110', name: 'Oil 1 Litre', tiers: [{ min_qty: 20, price: '100' }], category: 'Oils' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Oil 1 Litre', price: '110.00', category: 'Oils', stock_qty: 500 });
    expect(edited.body.tiers).toEqual([{ min_qty: 20, price: '100.00' }]);
    const detail = (await request(app).get(`/api/v1/catalog/${p.id}`).set(auth(d.token))).body;
    expect(detail.price_history.map((h: any) => [h.old_price, h.new_price])).toEqual([['100.00', '110.00'], [null, '100.00']]);
    // raising the base price above a tier is fine; dropping it below one is not
    expect((await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ price: '95' })).body.error.code).toBe('BAD_TIER');
    // past orders keep the price they were made at
    expect((await request(app).get(`/api/v1/orders/${(await buy(10, 'f')).body.order.id}`).set(auth(r.token))).body.total).toBe('1100.00');
  });

  it('duplicates a product as a hidden, empty draft', async () => {
    const d = await reg('distributor');
    const p = (await add(d.token, { name: 'Soap', sku: 'SP1', stock_qty: 30, tiers: [{ min_qty: 5, price: '90' }] })).body;
    const copy = (await request(app).post(`/api/v1/catalog/${p.id}/duplicate`).set(auth(d.token)).expect(201)).body;
    expect(copy).toMatchObject({ name: 'Soap (copy)', sku: null, is_active: false, stock_qty: 0 });
    expect(copy.tiers).toEqual([{ min_qty: 5, price: '90.00' }]);
  });
});

describe('bulk actions', () => {
  it('hides, re-prices, restocks, recategorises and deletes many products, only the caller\'s own', async () => {
    const d = await reg('distributor'); const other = await reg('distributor');
    const a = (await add(d.token, { name: 'A', price: '100', mrp: '120', stock_qty: 10, tiers: [{ min_qty: 5, price: '90' }] })).body;
    const b = (await add(d.token, { name: 'B', price: '50', stock_qty: 10 })).body;
    const foreign = (await add(other.token, { name: 'Foreign', price: '10', stock_qty: 10 })).body;
    const bulk = (action: string, value?: any) => request(app).post('/api/v1/catalog/bulk/apply').set(auth(d.token)).send({ ids: [a.id, b.id, foreign.id], action, value });

    expect((await bulk('price_percent', 10)).body.affected).toBe(2);   // the foreign id is silently ignored
    const afterPrice = (await request(app).get('/api/v1/catalog').set(auth(d.token))).body.products;
    expect(afterPrice.find((p: any) => p.name === 'A')).toMatchObject({ price: '110.00', mrp: '132.00', tiers: [{ min_qty: 5, price: '99.00' }] });
    expect(afterPrice.find((p: any) => p.name === 'B').price).toBe('55.00');
    expect((await q1<any>(pool, 'SELECT price_paise FROM products WHERE id = ?', [foreign.id]))!.price_paise).toBe(1000);

    expect((await bulk('price_percent', 1000)).status).toBe(400);
    await bulk('stock_add', 5);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [a.id]))!.stock_qty).toBe(15);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [foreign.id]))!.stock_qty).toBe(10);
    await bulk('set_category', 'Clearance');
    expect((await request(app).get('/api/v1/catalog?category=Clearance').set(auth(d.token))).body.total).toBe(2);
    await bulk('deactivate');
    expect((await request(app).get('/api/v1/catalog?status=hidden').set(auth(d.token))).body.total).toBe(2);
    await bulk('delete');
    expect((await request(app).get('/api/v1/catalog').set(auth(d.token))).body.total).toBe(0);
  });
});

describe('importing from a spreadsheet', () => {
  it('creates valid rows, reports bad rows by number, and updates by SKU when asked', async () => {
    const d = await reg('distributor');
    const rows = [
      { name: 'Sugar 1kg', price: '45', sku: 'SUG', category: 'Staples', stock: '200', gst: '5', hsn: '1701', unit: 'kg' },
      { name: 'Tea 250g', price: '120', mrp: '150', sku: 'TEA', stock: '30', gst: '5' },
      { name: '', price: '10' },                                     // row 3: no name
      { name: 'Bad GST', price: '10', gst: '7' },                    // row 4: not a slab
      { name: 'Cheap', price: '10', mrp: '5' },                      // row 5: MRP below price
      { name: 'Dup in file', price: '10', sku: 'SUG' },              // row 6: repeats a SKU from row 1
    ];
    const res = await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows }).expect(200);
    expect(res.body.created).toBe(2);
    expect(res.body.errors.map((e: any) => e.row)).toEqual([3, 4, 5, 6]);
    expect(res.body.errors[0].message).toContain('name');
    const list = (await request(app).get('/api/v1/catalog').set(auth(d.token))).body.products;
    expect(list.find((p: any) => p.sku === 'SUG')).toMatchObject({ price: '45.00', stock_qty: 200, gst_rate_bps: 500, hsn: '1701', unit: 'kg' });

    // importing again without "update" does not create duplicates and says so
    const again = await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [rows[0]] }).expect(200);
    expect(again.body).toMatchObject({ created: 0, updated: 0 });
    expect(again.body.errors[0].message).toContain('already exists');
    // with update-by-SKU: price and stock change, and the stock change is logged
    const up = await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [{ name: 'Sugar 1kg', sku: 'SUG', price: '48', stock: '150' }], upsert: true }).expect(200);
    expect(up.body).toMatchObject({ created: 0, updated: 1, errors: [] });
    const sug = (await request(app).get('/api/v1/catalog?q=SUG').set(auth(d.token))).body.products[0];
    expect(sug).toMatchObject({ price: '48.00', stock_qty: 150 });
    const hist = await q<any>(pool, 'SELECT delta, reason FROM stock_movements WHERE product_id = ? ORDER BY id', [sug.id]);
    expect(hist.map((h) => [h.delta, h.reason])).toEqual([[200, 'import'], [-50, 'import']]);

    // all-or-nothing refuses the whole file when any row is bad
    const strict = await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [{ name: 'Ok', price: '1' }, { name: '', price: '1' }], all_or_nothing: true });
    expect(strict.status).toBe(422);
    expect((await request(app).get('/api/v1/catalog?q=Ok').set(auth(d.token))).body.total).toBe(0);
  });
});

describe('what retailers see', () => {
  it('shows active products with search, categories, discounts and out-of-stock last', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    await add(d.token, { name: 'Zeta Soap', category: 'Care', price: '40', mrp: '50', stock_qty: 25 });
    await add(d.token, { name: 'Alpha Soap', category: 'Care', price: '40', stock_qty: 0 });
    await add(d.token, { name: 'Beta Oil', category: 'Oils', price: '100', stock_qty: 5, tiers: [{ min_qty: 10, price: '90' }] });
    await add(d.token, { name: 'Secret', price: '1', stock_qty: 5, is_active: false });
    const shop = (await request(app).get('/api/v1/retailer/stores').set(auth(r.token))).body.primary_distributor;
    expect(shop.products.map((p: any) => p.name)).toEqual(['Beta Oil', 'Zeta Soap', 'Alpha Soap']); // in stock first, hidden item absent
    expect(shop.categories).toEqual(['Care', 'Oils']);
    expect(shop.products.find((p: any) => p.name === 'Zeta Soap')).toMatchObject({ discount_pct: 20, stock_status: 'ok' });
    expect(shop.products.find((p: any) => p.name === 'Alpha Soap').stock_status).toBe('out');
    expect(shop.products.find((p: any) => p.name === 'Beta Oil').tiers).toEqual([{ min_qty: 10, price: '90.00' }]);
    const search = (await request(app).get(`/api/v1/retailer/stores/${d.id}/products?q=soap`).set(auth(r.token))).body;
    expect(search.products.map((p: any) => p.name)).toEqual(['Zeta Soap', 'Alpha Soap']);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products?category=Oils`).set(auth(r.token))).body.products).toHaveLength(1);
  });
});
