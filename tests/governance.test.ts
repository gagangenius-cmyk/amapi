import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q, q1 } from '../src/db/pool';
import { setApprovalRequired } from '../src/modules/catalog/governance';

const app = createApp();
let n = 0;
const phone = () => String(7500000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
}
async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = (await request(app).post('/api/v1/auth/register').send(body).expect(201)).body;
  return { id: r.id as number, token: r.access_token as string, phone: p };
}
/** A distributor with a linked retailer. */
async function pair() {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  return { d, r };
}
const addProduct = (t: string, over: object = {}) =>
  request(app).post('/api/v1/catalog').set(auth(t)).send({ name: 'Rice ' + ++n, price: '100', stock_qty: 20, gst_rate_bps: 0, ...over });
const store = async (r: { token: string }, did: number) => (await request(app).get(`/api/v1/retailer/stores/${did}/products`).set(auth(r.token)).expect(200)).body.products as any[];
let k = 0;
const order = (r: { token: string }, did: number, pid: number) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'gv' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty: 1 }] });

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await setApprovalRequired(false).catch(() => {}); await pool.end(); });

describe('managed categories and brands', () => {
  it('a new name is created as pending, and the same name in any case reuses it', async () => {
    const d = await reg('distributor'); const a = await admin();
    const p1 = (await addProduct(d.token, { category: 'Staples', brand: 'Tata' }).expect(201)).body;
    const p2 = (await addProduct(d.token, { category: '  staples ', brand: 'TATA' }).expect(201)).body;
    expect(p1.category_id).toBeTruthy();
    expect(p2.category_id).toBe(p1.category_id);
    expect(p2.brand_id).toBe(p1.brand_id);
    expect(p2.category).toBe('Staples');                       // the canonical spelling wins

    const cats = (await request(app).get('/api/v1/admin/categories').query({ status: 'pending' }).set(auth(a)).expect(200)).body.items;
    expect(cats.find((c: any) => c.id === p1.category_id)).toMatchObject({ name: 'Staples', status: 'pending', products: 2 });
  });

  it('a distributor can pick by id, and an unknown id is refused', async () => {
    const d = await reg('distributor'); const a = await admin();
    const cat = (await request(app).post('/api/v1/admin/categories').set(auth(a)).send({ name: 'Dairy' }).expect(201)).body;
    const p = (await addProduct(d.token, { category_id: cat.id }).expect(201)).body;
    expect(p).toMatchObject({ category: 'Dairy', category_id: cat.id });
    expect((await addProduct(d.token, { category_id: 999999 })).body.error.code).toBe('UNKNOWN_CATEGORY');
    const tax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(d.token)).expect(200)).body;
    expect(tax.categories.map((c: any) => c.name)).toContain('Dairy');
  });

  it('renaming updates every product; merging moves products and retires the old name', async () => {
    const d = await reg('distributor'); const a = await admin();
    const p1 = (await addProduct(d.token, { category: 'Snaks' }).expect(201)).body;
    const good = (await request(app).post('/api/v1/admin/categories').set(auth(a)).send({ name: 'Snacks' }).expect(201)).body;
    await request(app).put(`/api/v1/admin/categories/${p1.category_id}`).set(auth(a)).send({ name: 'Snaks & Chips' }).expect(200);
    expect((await q1<any>(pool, 'SELECT category FROM products WHERE id = ?', [p1.id]))!.category).toBe('Snaks & Chips');

    const merged = (await request(app).post(`/api/v1/admin/categories/${p1.category_id}/merge`).set(auth(a)).send({ into_id: good.id }).expect(200)).body;
    expect(merged.products_moved).toBe(1);
    const row = await q1<any>(pool, 'SELECT category, category_id FROM products WHERE id = ?', [p1.id]);
    expect(row).toMatchObject({ category: 'Snacks', category_id: good.id });
    // someone typing the old name later lands on the replacement, not on a duplicate
    const again = (await addProduct(d.token, { category: 'Snaks & Chips' }).expect(201)).body;
    expect(again.category_id).toBe(good.id);
    expect((await request(app).post(`/api/v1/admin/categories/${good.id}/merge`).set(auth(a)).send({ into_id: good.id })).status).toBe(400);
  });

  it('refuses a duplicate name, and only the admin manages the lists', async () => {
    const a = await admin(); const d = await reg('distributor');
    await request(app).post('/api/v1/admin/brands').set(auth(a)).send({ name: 'Amul' }).expect(201);
    expect((await request(app).post('/api/v1/admin/brands').set(auth(a)).send({ name: ' amul ' })).status).toBe(409);
    expect((await request(app).post('/api/v1/admin/brands').set(auth(d.token)).send({ name: 'Mine' })).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/categories').set(auth(d.token))).status).toBe(403);
  });

  it('keeps products that were created before this feature working through bulk and import paths', async () => {
    const d = await reg('distributor');
    const imp = (await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [{ name: 'Sugar', price: '45', category: 'Staples', brand: 'Madhur' }] }).expect(200)).body;
    expect(imp.created).toBe(1);
    const list = (await request(app).get('/api/v1/catalog').set(auth(d.token)).expect(200)).body.products as any[];
    expect(list[0]).toMatchObject({ category: 'Staples', brand: 'Madhur' });
    expect(list[0].category_id).toBeTruthy();
    await request(app).post('/api/v1/catalog/bulk/apply').set(auth(d.token)).send({ ids: [list[0].id], action: 'set_category', value: 'Sweeteners' }).expect(200);
    const after = await q1<any>(pool, 'SELECT category, category_id FROM products WHERE id = ?', [list[0].id]);
    expect(after.category).toBe('Sweeteners');
    expect(after.category_id).toBeTruthy();
  });
});

describe('product approval', () => {
  it('off by default: new products are live straight away', async () => {
    const { d, r } = await pair();
    const p = (await addProduct(d.token).expect(201)).body;
    expect(p.review_status).toBe('approved');
    expect((await store(r, d.id)).map((x) => x.id)).toContain(p.id);
  });

  it('when on, a new product is hidden and cannot be ordered until approved', async () => {
    const a = await admin(); const { d, r } = await pair();
    await request(app).put('/api/v1/admin/catalog-settings').set(auth(a)).send({ product_approval_required: true }).expect(200);
    try {
      const p = (await addProduct(d.token).expect(201)).body;
      expect(p.review_status).toBe('pending');
      expect((await store(r, d.id)).map((x) => x.id)).not.toContain(p.id);
      expect((await order(r, d.id, p.id)).status).toBe(400);                          // unknown or unavailable
      // the distributor still sees it, with its status
      expect((await request(app).get('/api/v1/catalog').set(auth(d.token))).body.products[0]).toMatchObject({ id: p.id, review_status: 'pending' });

      const queue = (await request(app).get('/api/v1/admin/product-review').set(auth(a)).expect(200)).body.products;
      expect(queue.map((x: any) => x.id)).toContain(p.id);

      await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(a)).send({ action: 'approve' }).expect(200);
      expect((await store(r, d.id)).map((x) => x.id)).toContain(p.id);
      expect((await order(r, d.id, p.id)).status).toBe(201);
      // decided once
      expect((await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(a)).send({ action: 'reject', note: 'x' })).status).toBe(409);
    } finally { await setApprovalRequired(false); }
  });

  it('a rejection needs a reason, shows it to the distributor, and fixing the product sends it back for review', async () => {
    const a = await admin(); const { d, r } = await pair();
    await setApprovalRequired(true);
    try {
      const p = (await addProduct(d.token, { name: 'Mystery Powder' }).expect(201)).body;
      expect((await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(a)).send({ action: 'reject' })).body.error.code).toBe('NOTE_REQUIRED');
      await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(a)).send({ action: 'reject', note: 'Add the HSN code' }).expect(200);
      const seen = (await request(app).get('/api/v1/catalog').set(auth(d.token))).body.products.find((x: any) => x.id === p.id);
      expect(seen).toMatchObject({ review_status: 'rejected', review_note: 'Add the HSN code' });
      expect((await store(r, d.id)).map((x) => x.id)).not.toContain(p.id);

      const fixed = (await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ hsn: '1101' }).expect(200)).body;
      expect(fixed).toMatchObject({ review_status: 'pending', review_note: null });
    } finally { await setApprovalRequired(false); }
  });

  it('approving a product also accepts the new category and brand it introduced', async () => {
    const a = await admin(); const { d } = await pair();
    await setApprovalRequired(true);
    try {
      const p = (await addProduct(d.token, { category: 'Pulses Special', brand: 'Kisan Fresh' }).expect(201)).body;
      expect((await q1<any>(pool, 'SELECT status FROM categories WHERE id = ?', [p.category_id]))!.status).toBe('pending');
      await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(a)).send({ action: 'approve' }).expect(200);
      expect((await q1<any>(pool, 'SELECT status FROM categories WHERE id = ?', [p.category_id]))!.status).toBe('active');
      expect((await q1<any>(pool, 'SELECT status FROM brands WHERE id = ?', [p.brand_id]))!.status).toBe('active');
    } finally { await setApprovalRequired(false); }
  });

  it('only the admin decides', async () => {
    const { d } = await pair(); const p = (await addProduct(d.token).expect(201)).body;
    expect((await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(d.token)).send({ action: 'approve' })).status).toBe(403);
    expect((await request(app).put('/api/v1/admin/catalog-settings').set(auth(d.token)).send({ product_approval_required: true })).status).toBe(403);
  });
});

describe('product version history', () => {
  it('records the creation and each real change, with what changed, and skips no-op edits', async () => {
    const d = await reg('distributor');
    const p = (await addProduct(d.token, { name: 'Atta', price: '300', category: 'Flour' }).expect(201)).body;
    await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ price: '320', hsn: '1101' }).expect(200);
    await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ price: '320' }).expect(200);          // nothing changed
    await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ is_active: false }).expect(200);

    const v = (await request(app).get(`/api/v1/catalog/${p.id}/versions`).set(auth(d.token)).expect(200)).body.versions;
    expect(v.map((x: any) => x.version)).toEqual([3, 2, 1]);
    expect(v[2]).toMatchObject({ change_type: 'create', by: 'Owner' });
    expect(v[2].snapshot).toMatchObject({ name: 'Atta', price: '300.00', category: 'Flour' });
    expect(v[1].changes).toEqual({ price: { from: '300.00', to: '320.00' }, hsn: { from: null, to: '1101' } });
    expect(v[0].changes).toEqual({ is_active: { from: true, to: false } });
  });

  it('tracks quantity breaks and review decisions, and stock changes are not versions', async () => {
    const a = await admin(); const d = await reg('distributor');
    await setApprovalRequired(true);
    try {
      const p = (await addProduct(d.token, { name: 'Oil', price: '200' }).expect(201)).body;
      await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ delta: 5 }).expect(200);
      await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(d.token)).send({ tiers: [{ min_qty: 10, price: '190' }] }).expect(200);
      await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(a)).send({ action: 'approve' }).expect(200);

      const v = (await request(app).get(`/api/v1/admin/products/${p.id}/versions`).set(auth(a)).expect(200)).body.versions;
      expect(v.map((x: any) => x.change_type)).toEqual(['review_approved', 'update', 'create']);
      expect(v[1].changes.tiers).toEqual({ from: [], to: [{ min_qty: 10, price: '190.00' }] });
      expect(v[0].changes).toEqual({ review_status: { from: 'pending', to: 'approved' } });
      expect(v[0].by).toBe('Admin');
    } finally { await setApprovalRequired(false); }
  });

  it('versions belong to the product\'s owner', async () => {
    const d = await reg('distributor'); const other = await reg('distributor');
    const p = (await addProduct(d.token).expect(201)).body;
    expect((await request(app).get(`/api/v1/catalog/${p.id}/versions`).set(auth(other.token))).status).toBe(404);
    const rows = await q(pool, 'SELECT * FROM product_versions WHERE product_id = ?', [p.id]);
    expect(rows).toHaveLength(1);
  });
});
