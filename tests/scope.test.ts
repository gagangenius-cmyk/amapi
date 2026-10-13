import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';
import { cleanSocial } from '../src/modules/distributors/social';
import { withDescendants } from '../src/modules/catalog/scope';
import { makeCategory, onboardDistributor } from './helpers/onboard';

const app = createApp();
let n = 0;
const phone = () => String(5200000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let k = 0;

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return { token: (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string };
}
const POWERS = ['create_distributors', 'manage_distributors', 'review_products', 'view_team_reports'];
const GRANTS = ['notifications_enabled', 'employees_enabled', 'cod_enabled', 'chat_enabled', 'khatabook_enabled', 'self_delivery', 'online_payments'];
async function employee(a: { token: string }, actions = POWERS) {
  const p = phone();
  const s = (await request(app).post('/api/v1/admin/staff').set(auth(a.token)).send({ phone: p, name: 'Emp ' + n, password: 'password123', actions, grantable: GRANTS }).expect(201)).body;
  return { id: s.id as number, token: (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string };
}
const login = async (p: string) => (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;

/** A distributor onboarded through a company employee, with categories, ready to sell. */
async function shop(over: Record<string, unknown> = {}, cats: { id: number; name: string }[] = []) {
  const a = await admin(); const e = await employee(a);
  const cs = cats.length ? cats : [await makeCategory(app, a.token, 'Beverages ' + ++k), await makeCategory(app, a.token, 'Hardware ' + k)];
  const d = await onboardDistributor(app, a, e, { category_ids: cs.map((c) => c.id), review_required: false, permissions: { notifications_enabled: true, employees_enabled: true }, ...over });
  return { a, e, d, cats: cs };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const product = async (s: Shop, name: string, categoryId: number | null, price = '100') =>
  (await request(app).post('/api/v1/catalog').set(auth(s.d.token)).send({ name, price, stock_qty: 50, gst_rate_bps: 0, ...(categoryId ? { category_id: categoryId } : {}) }).expect(201)).body as { id: number };
const retailer = async (s: Shop, categoryIds: number[], over: Record<string, unknown> = {}, as = s.d.token) => {
  const p = phone();
  const r = (await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(as)).send({ phone: p, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + n, pincode: '400001', category_ids: categoryIds, ...over }).expect(201)).body;
  return { id: r.id as number, token: await login(p), phone: p };
};
const store = async (r: { token: string }, did: number, qs = '') => (await request(app).get(`/api/v1/retailer/stores/${did}/products${qs}`).set(auth(r.token)).expect(200)).body;
const order = (r: { token: string }, did: number, pid: number, extra: object = {}) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'sc' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty: 1 }], ...extra });

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('category rules (pure)', () => {
  it('a category covers its sub-categories, however deep', () => {
    const all = [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 4, parent_id: null }, { id: 5, parent_id: 4 }];
    expect([...withDescendants(all, [1])].sort()).toEqual([1, 2, 3]);
    expect([...withDescendants(all, [4, 3])].sort()).toEqual([3, 4, 5]);
    expect([...withDescendants(all, [])]).toEqual([]);
  });
});

describe('a retailer only sees prices for the categories it was given', () => {
  it('shows each retailer only the products of its categories, and refuses orders for the rest', async () => {
    const s = await shop();
    const [bev, hw] = s.cats;
    const cola = await product(s, 'Cola', bev.id); const drill = await product(s, 'Drill', hw.id); const loose = await product(s, 'Uncategorised thing', null);
    const A = await retailer(s, [bev.id]); const B = await retailer(s, [hw.id]);

    expect((await store(A, s.d.id)).products.map((p: any) => p.name)).toEqual(['Cola']);
    expect((await store(B, s.d.id)).products.map((p: any) => p.name)).toEqual(['Drill']);
    expect((await store(A, s.d.id, '?q=Drill')).products).toEqual([]);                     // cannot search around it
    expect(JSON.stringify(await store(A, s.d.id))).not.toMatch(/Drill|Uncategorised/);     // the other products' names and prices are simply not sent
    expect((await order(A, s.d.id, drill.id)).body.error.code).toBe('BAD_PRODUCT');
    expect((await order(A, s.d.id, loose.id)).status).toBe(400);
    expect((await order(A, s.d.id, cola.id)).status).toBe(201);
    expect((await order(B, s.d.id, drill.id)).status).toBe(201);

    // the category chips and the product counts follow the same rule
    expect((await store(A, s.d.id)).categories).toEqual([bev.name]);
    expect((await store(B, s.d.id)).categories).toEqual([hw.name]);
    const home = (await request(app).get('/api/v1/retailer/stores').set(auth(A.token)).expect(200)).body;
    expect(home.primary_distributor.product_count).toBe(1);
    expect((await request(app).get(`/api/v1/retailer/stores/${s.d.id}`).set(auth(B.token)).expect(200)).body.product_count).toBe(1);
  });

  it('a retailer given a category also sees its sub-categories', async () => {
    const s = await shop();
    const [bev] = s.cats;
    const child = (await request(app).post('/api/v1/admin/categories').set(auth(s.a.token)).send({ name: 'Juices ' + ++k, parent_id: bev.id }).expect(201)).body;
    const juice = await product(s, 'Mango Juice', child.id);
    const R = await retailer(s, [bev.id]);
    expect((await store(R, s.d.id)).products.map((p: any) => p.id)).toEqual([juice.id]);
  });

  it('only categories the distributor deals in can be given, and at least one is required', async () => {
    const s = await shop();
    const other = await makeCategory(app, s.a.token, 'Toys ' + ++k);
    const mk = (b: object) => request(app).post('/api/v1/distributor/retailer-accounts').set(auth(s.d.token)).send({ phone: phone(), name: 'Retailer', password: 'password123', shop_name: 'Shop', pincode: '400001', ...b });
    expect((await mk({ category_ids: [other.id] })).body.error.code).toBe('CATEGORY_NOT_OFFERED');
    expect((await mk({})).body.error.code).toBe('CATEGORY_REQUIRED');
    expect((await mk({ category_ids: [] })).body.error.code).toBe('CATEGORY_REQUIRED');
    expect((await mk({ category_ids: [999999] })).body.error.code).toBe('BAD_CATEGORY');
    expect((await mk({ category_ids: [s.cats[0].id] })).status).toBe(201);
  });

  it('a team member creating a retailer has to choose categories too, from the same list', async () => {
    const s = await shop();
    const ep = phone();
    await request(app).post('/api/v1/distributor/employees').set(auth(s.d.token)).send({ phone: ep, name: 'Rep', password: 'password123' }).expect(201);
    const et = await login(ep);
    const R = await retailer(s, [s.cats[1].id], {}, et);
    const row = await q1<any>(pool, 'SELECT managed_by_id FROM users WHERE id = ?', [R.id]);
    expect(row!.managed_by_id).not.toBeNull();
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(et)).send({ phone: phone(), name: 'Retailer', password: 'password123', shop_name: 'Shop', pincode: '400001' })).body.error.code).toBe('CATEGORY_REQUIRED');
  });

  it('the distributor can change a retailer\'s categories later, and the storefront follows at once', async () => {
    const s = await shop();
    const [bev, hw] = s.cats;
    await product(s, 'Cola', bev.id); await product(s, 'Drill', hw.id);
    const R = await retailer(s, [bev.id]);
    expect((await store(R, s.d.id)).products.map((p: any) => p.name)).toEqual(['Cola']);
    await request(app).put(`/api/v1/distributor/retailers/${R.id}/categories`).set(auth(s.d.token)).send({ category_ids: [hw.id] }).expect(200);
    expect((await store(R, s.d.id)).products.map((p: any) => p.name)).toEqual(['Drill']);
    const shown = (await request(app).get(`/api/v1/distributor/retailers/${R.id}/categories`).set(auth(s.d.token)).expect(200)).body;
    expect(shown.categories.map((c: any) => c.id)).toEqual([hw.id]);
    expect((await request(app).put(`/api/v1/distributor/retailers/${R.id}/categories`).set(auth(s.d.token)).send({ category_ids: [] })).body.error.code).toBe('CATEGORY_REQUIRED');
    const rival = await shop();
    expect((await request(app).put(`/api/v1/distributor/retailers/${R.id}/categories`).set(auth(rival.d.token)).send({ category_ids: [rival.cats[0].id] })).status).toBe(404);
  });

  it('narrowing the distributor\'s categories narrows what its retailers see', async () => {
    const s = await shop();
    const [bev, hw] = s.cats;
    await product(s, 'Cola', bev.id); await product(s, 'Drill', hw.id);
    const R = await retailer(s, [bev.id, hw.id]);
    expect((await store(R, s.d.id)).products.map((p: any) => p.name).sort()).toEqual(['Cola', 'Drill']);
    await request(app).put(`/api/v1/staff/distributors/${s.d.id}`).set(auth(s.e.token)).send({ category_ids: [bev.id] }).expect(200);
    expect((await store(R, s.d.id)).products.map((p: any) => p.name)).toEqual(['Cola']);
  });

  it('a retailer who signed up by itself, with no categories, is not restricted', async () => {
    const s = await shop();
    await product(s, 'Cola', s.cats[0].id); await product(s, 'Drill', s.cats[1].id);
    const p = phone();
    const reg = (await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `free${n}@t.local`, name: 'Free Retailer', password: 'password123', shop_name: 'Free Shop', pincode: '400001' }).expect(201)).body;
    await request(app).post('/api/v1/distributor/retailers').set(auth(s.d.token)).send({ phone: p }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${s.d.id}/accept`).set(auth(reg.access_token)).expect(200);
    expect((await store({ token: reg.access_token }, s.d.id)).products.map((x: any) => x.name).sort()).toEqual(['Cola', 'Drill']);
  });

  it('the prices a retailer is shown are not visible to other retailers or to the public', async () => {
    const s = await shop();
    const cola = await product(s, 'Cola', s.cats[0].id, '77');
    const A = await retailer(s, [s.cats[0].id]); const B = await retailer(s, [s.cats[1].id]);
    expect((await store(A, s.d.id)).products[0]).toMatchObject({ id: cola.id, price: '77.00' });
    expect(JSON.stringify(await store(B, s.d.id))).not.toContain('77.00');
    expect((await request(app).get(`/api/v1/retailer/stores/${s.d.id}/products`)).status).toBe(401);
  });
});

describe('a distributor may only list products in its own categories', () => {
  const post = (s: Shop, b: object) => request(app).post('/api/v1/catalog').set(auth(s.d.token)).send({ price: '10', stock_qty: 5, gst_rate_bps: 0, ...b });

  it('refuses a category that is not theirs, and accepts theirs by name, by id, or a sub-category', async () => {
    const s = await shop();
    const [bev] = s.cats;
    const bad = await post(s, { name: 'Wrong shelf', category: 'Toys and Games' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CATEGORY_NOT_YOURS');
    const other = await makeCategory(app, s.a.token, 'Elsewhere ' + ++k);
    expect((await post(s, { name: 'Elsewhere item', category_id: other.id })).body.error.code).toBe('CATEGORY_NOT_YOURS');
    expect((await post(s, { name: 'By name', category: bev.name.toUpperCase() })).status).toBe(201);          // matching ignores case
    expect((await post(s, { name: 'By id', category_id: bev.id })).status).toBe(201);
    const child = (await request(app).post('/api/v1/admin/categories').set(auth(s.a.token)).send({ name: 'Sodas ' + ++k, parent_id: bev.id }).expect(201)).body;
    expect((await post(s, { name: 'Sub item', category_id: child.id })).status).toBe(201);
    expect((await post(s, { name: 'No category at all' })).status).toBe(201);                                    // allowed, though restricted retailers will not see it
  });

  it('the same rule holds when editing, changing in bulk, and importing', async () => {
    const s = await shop();
    const [bev] = s.cats;
    const p = (await post(s, { name: 'Cola', category_id: bev.id }).expect(201)).body;
    expect((await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(s.d.token)).send({ category: 'Toys and Games' })).body.error.code).toBe('CATEGORY_NOT_YOURS');
    expect((await request(app).post('/api/v1/catalog/bulk/apply').set(auth(s.d.token)).send({ ids: [p.id], action: 'set_category', value: 'Toys and Games' })).body.error.code).toBe('CATEGORY_NOT_YOURS');
    const imp = (await request(app).post('/api/v1/catalog/import/rows').set(auth(s.d.token)).send({ rows: [
      { name: 'Good row', price: '10', category: bev.name }, { name: 'Bad row', price: '10', category: 'Toys and Games' },
    ] }).expect(200)).body;
    expect(imp.created).toBe(1);
    expect(imp.errors).toEqual([{ row: 2, message: expect.stringContaining('not one of your categories') }]);
  });

  it('the product form is offered only the categories it may use', async () => {
    const s = await shop();
    const [bev] = s.cats;
    const child = (await request(app).post('/api/v1/admin/categories').set(auth(s.a.token)).send({ name: 'Cola types ' + ++k, parent_id: bev.id }).expect(201)).body;
    const tax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(s.d.token)).expect(200)).body;
    expect(tax.restricted).toBe(true);
    expect(tax.categories.map((c: any) => c.id).sort()).toEqual([s.cats[0].id, s.cats[1].id, child.id].sort());
    expect(tax.categories.map((c: any) => c.name)).not.toContain('Elsewhere');
  });

  it('a distributor who signed up by itself is not restricted', async () => {
    const p = phone();
    const reg = (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `free${n}@t.local`, name: 'Free Owner', password: 'password123', business_name: 'Free Traders' }).expect(201)).body;
    const t = reg.access_token as string;
    expect((await request(app).post('/api/v1/catalog').set(auth(t)).send({ name: 'Anything', price: '10', stock_qty: 5, category: 'Whatever I like' })).status).toBe(201);
    expect((await request(app).get('/api/v1/catalog/taxonomy').set(auth(t)).expect(200)).body.restricted).toBe(false);
  });
});

describe('products kept for chosen retailers, and a price list only that retailer can download', () => {
  const keep = (s: Shop, pid: number, ids: number[]) => request(app).put(`/api/v1/catalog/${pid}/audience`).set(auth(s.d.token)).send({ retailer_ids: ids });
  const csv = (r: { token: string }, did: number) => request(app).get(`/api/v1/retailer/stores/${did}/price-list.csv`).set(auth(r.token));

  it('only the chosen retailers can see, search, count or order a private product', async () => {
    const s = await shop();
    const c = s.cats[0].id;
    const open = await product(s, 'Open Cola', c); const secret = await product(s, 'Secret Blend', c, '55');
    const A = await retailer(s, [c]); const B = await retailer(s, [c]);
    await keep(s, secret.id, [A.id]).expect(200);

    expect((await store(A, s.d.id)).products.map((p: any) => p.name).sort()).toEqual(['Open Cola', 'Secret Blend']);
    expect((await store(B, s.d.id)).products.map((p: any) => p.name)).toEqual(['Open Cola']);
    expect((await store(B, s.d.id, '?q=Secret')).products).toEqual([]);
    expect(JSON.stringify(await store(B, s.d.id))).not.toMatch(/Secret|55\.00/);
    expect((await request(app).get('/api/v1/retailer/stores').set(auth(B.token)).expect(200)).body.primary_distributor.product_count).toBe(1);
    expect((await request(app).get(`/api/v1/retailer/stores/${s.d.id}`).set(auth(A.token)).expect(200)).body.product_count).toBe(2);
    expect((await order(B, s.d.id, secret.id)).status).toBe(400);
    expect((await order(A, s.d.id, secret.id)).status).toBe(201);
    expect((await order(B, s.d.id, open.id)).status).toBe(201);
  });

  it('the distributor sees which products are private, can change the list, and can open one to everyone again', async () => {
    const s = await shop();
    const c = s.cats[0].id;
    const secret = await product(s, 'Secret Blend', c);
    const A = await retailer(s, [c]); const B = await retailer(s, [c]);
    await keep(s, secret.id, [A.id, B.id]).expect(200);
    expect((await request(app).get('/api/v1/catalog').set(auth(s.d.token))).body.products.find((p: any) => p.id === secret.id).private_to).toBe(2);
    expect((await request(app).get(`/api/v1/catalog/${secret.id}/audience`).set(auth(s.d.token)).expect(200)).body.retailers).toHaveLength(2);
    await keep(s, secret.id, [B.id]).expect(200);
    expect((await store(A, s.d.id)).products).toEqual([]);
    await keep(s, secret.id, []).expect(200);
    expect((await store(A, s.d.id)).products.map((p: any) => p.name)).toEqual(['Secret Blend']);
  });

  it("only a distributor's own connected retailers can be chosen, and only for their own products", async () => {
    const s = await shop(); const other = await shop();
    const mine = await retailer(s, [s.cats[0].id]); const theirs = await retailer(other, [other.cats[0].id]);
    const p = await product(s, 'Thing', s.cats[0].id);
    expect((await keep(s, p.id, [theirs.id])).body.error.code).toBe('NOT_YOUR_RETAILER');
    expect((await keep(other, p.id, [theirs.id])).status).toBe(404);
    expect((await request(app).put(`/api/v1/catalog/${p.id}/audience`).set(auth(mine.token)).send({ retailer_ids: [] })).status).toBe(403);
  });

  it('a retailer downloads his own price list, with the prices he pays; no other retailer products or prices are in it', async () => {
    const s = await shop();
    const c = s.cats[0].id;
    const open = await product(s, 'Open Cola', c, '100'); const secret = await product(s, 'Secret Blend', c, '80');
    const A = await retailer(s, [c]); const B = await retailer(s, [c]);
    await keep(s, secret.id, [A.id]).expect(200);
    const list = (await request(app).post('/api/v1/pricing/lists').set(auth(s.d.token)).send({ name: 'A contract', kind: 'contract' }).expect(201)).body;
    await request(app).post(`/api/v1/pricing/lists/${list.id}/items`).set(auth(s.d.token)).send({ product_id: open.id, price: '90' }).expect(201);
    await request(app).put(`/api/v1/pricing/lists/${list.id}/members`).set(auth(s.d.token)).send({ retailer_ids: [A.id] }).expect(200);

    const a = await csv(A, s.d.id).expect(200);
    expect(a.headers['content-type']).toContain('text/csv');
    expect(a.headers['cache-control']).toContain('no-store');
    expect(a.headers['content-disposition']).toContain('attachment');
    const aLines = a.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(aLines[0]).toContain('Your price');
    expect(aLines.find((l) => l.startsWith('Open Cola'))).toContain(',90.00,');                 // his contract price, not the standard 100
    expect(aLines.find((l) => l.startsWith('Secret Blend'))).toContain(',80.00,');

    const b = (await csv(B, s.d.id).expect(200)).text;
    expect(b).toContain('Open Cola,');
    expect(b).toContain(',100.00,');                                                            // the standard price for him
    expect(b).not.toMatch(/Secret|90\.00|80\.00|contract/i);
  });

  it('needs sign-in and a store the retailer may see; distributors and strangers cannot use it', async () => {
    const s = await shop(); const other = await shop();
    const A = await retailer(s, [s.cats[0].id]); const Z = await retailer(other, [other.cats[0].id]);
    expect((await request(app).get(`/api/v1/retailer/stores/${s.d.id}/price-list.csv`)).status).toBe(401);
    expect((await request(app).get(`/api/v1/retailer/stores/${s.d.id}/price-list.csv`).set(auth(s.d.token))).status).toBe(403);
    expect((await csv(Z, s.d.id)).status).toBe(404);                                            // not their distributor, not in their area
    await csv(A, s.d.id).expect(200);
  });

  it('a formula typed as a product name cannot run when the sheet is opened', async () => {
    const s = await shop();
    await product(s, '=HYPERLINK("http://evil.example")', s.cats[0].id);
    const A = await retailer(s, [s.cats[0].id]);
    const text = (await csv(A, s.d.id).expect(200)).text;
    expect(text).toContain("'=HYPERLINK");
  });
});

describe('cash on delivery', () => {
  it('is refused unless the distributor was given it', async () => {
    const s = await shop();
    const p = await product(s, 'Cola', s.cats[0].id);
    const R = await retailer(s, [s.cats[0].id]);
    const r = await order(R, s.d.id, p.id, { payment_method: 'cod' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('COD_NOT_AVAILABLE');
    const normal = await order(R, s.d.id, p.id);
    expect(normal.body.order.payment_method).toBe('credit');
  });

  it('is accepted when granted, shown on the order, and is not held back by the credit limit', async () => {
    const s = await shop({ permissions: { cod_enabled: true, notifications_enabled: true } });
    const p = await product(s, 'Cola', s.cats[0].id, '100');
    const R = await retailer(s, [s.cats[0].id]);
    expect((await request(app).get(`/api/v1/retailer/stores/${s.d.id}`).set(auth(R.token))).body.accepts_cod).toBe(true);
    await request(app).put(`/api/v1/collections/terms/${R.id}`).set(auth(s.d.token)).send({ credit_limit: '50', credit_days: 0 }).expect(200);

    expect((await order(R, s.d.id, p.id)).body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');          // on account: over the limit
    const cod = await order(R, s.d.id, p.id, { payment_method: 'cod' });                              // cash on delivery: nothing owed
    expect(cod.status).toBe(201);
    expect(cod.body.order).toMatchObject({ payment_method: 'cod', total: '100.00' });
    // a COD order waiting for acceptance does not eat into the credit limit of later orders
    await request(app).put(`/api/v1/collections/terms/${R.id}`).set(auth(s.d.token)).send({ credit_limit: '150', credit_days: 0 }).expect(200);
    expect((await order(R, s.d.id, p.id)).status).toBe(201);
    const seen = (await request(app).get(`/api/v1/orders/${cod.body.order.id}`).set(auth(s.d.token)).expect(200)).body;
    expect(seen.payment_method).toBe('cod');
    expect((await order(R, s.d.id, p.id, { payment_method: 'barter' })).status).toBe(400);
  });

  it('the same cart with a different payment method is not mistaken for a retry', async () => {
    const s = await shop({ permissions: { cod_enabled: true, notifications_enabled: true } });
    const p = await product(s, 'Cola', s.cats[0].id);
    const R = await retailer(s, [s.cats[0].id]);
    const key = 'pm-' + ++k;
    const go = (pm: string) => request(app).post('/api/v1/orders').set(auth(R.token)).set('Idempotency-Key', key).send({ distributor_id: s.d.id, payment_method: pm, items: [{ product_id: p.id, qty: 1 }] });
    expect((await go('credit')).status).toBe(201);
    expect((await go('cod')).status).toBe(422);
  });
});

describe('social links on the store', () => {
  it('cleans, checks and shows them to the retailer', async () => {
    const s = await shop();
    const R = await retailer(s, [s.cats[0].id]);
    const put = (social_links: object) => request(app).put('/api/v1/distributor/me').set(auth(s.d.token)).send({ social_links });
    const ok = await put({ whatsapp: '98765 43210', facebook: 'facebook.com/mystore', instagram: 'https://www.instagram.com/mystore/', youtube: 'https://youtube.com/@mystore', maps: 'https://maps.app.goo.gl/AbCdEf' }).expect(200);
    expect(ok.body.social_links).toEqual({
      whatsapp: 'https://wa.me/919876543210', facebook: 'https://facebook.com/mystore', instagram: 'https://www.instagram.com/mystore/',
      youtube: 'https://youtube.com/@mystore', maps: 'https://maps.app.goo.gl/AbCdEf',
    });
    const profile = (await request(app).get(`/api/v1/retailer/stores/${s.d.id}`).set(auth(R.token)).expect(200)).body;
    expect(profile.social_links.instagram).toBe('https://www.instagram.com/mystore/');
    const home = (await request(app).get('/api/v1/retailer/stores').set(auth(R.token)).expect(200)).body;
    expect(home.primary_distributor.social_links.whatsapp).toBe('https://wa.me/919876543210');

    // one can be removed with an empty value; the rest stay
    const removed = await put({ youtube: '' }).expect(200);
    expect(removed.body.social_links.youtube).toBeUndefined();
    expect(removed.body.social_links.facebook).toBe('https://facebook.com/mystore');
  });

  it('refuses links that are not what they claim to be', async () => {
    const s = await shop();
    const bad = async (social_links: object) => (await request(app).put('/api/v1/distributor/me').set(auth(s.d.token)).send({ social_links })).body.error?.code;
    expect(await bad({ facebook: 'javascript:alert(1)' })).toBe('BAD_LINK');
    expect(await bad({ facebook: 'https://evil.example/facebook.com' })).toBe('BAD_LINK');
    expect(await bad({ instagram: 'http://instagram.com.evil.example/x' })).toBe('BAD_LINK');
    expect(await bad({ maps: 'https://www.google.com/search?q=shop' })).toBe('BAD_LINK');
    expect(await bad({ whatsapp: 'not a number' })).toBe('BAD_LINK');
    expect((await request(app).put('/api/v1/distributor/me').set(auth(s.d.token)).send({ social_links: { tiktok: 'https://tiktok.com/x' } })).status).toBe(400);
  });

  it('cleanSocial accepts the real forms of each link', () => {
    expect(cleanSocial('whatsapp', '+91 98765-43210')).toBe('https://wa.me/919876543210');
    expect(cleanSocial('whatsapp', '919876543210')).toBe('https://wa.me/919876543210');
    expect(cleanSocial('whatsapp', 'https://wa.me/919876543210?text=hi')).toContain('wa.me/919876543210');
    expect(cleanSocial('youtube', 'https://youtu.be/abc')).toBe('https://youtu.be/abc');
    expect(cleanSocial('maps', 'https://www.google.com/maps/place/Shop')).toContain('/maps/place/Shop');
    expect(cleanSocial('maps', 'https://goo.gl/maps/xyz')).toContain('goo.gl/maps/xyz');
    expect(cleanSocial('facebook', '   ')).toBe('remove');
    expect(cleanSocial('facebook', 'https://user:pw@facebook.com/x')).toBeNull();
    expect(cleanSocial('facebook', 'x'.repeat(400))).toBeNull();
  });
});

describe('offers to chosen retailers', () => {
  const feed = async (r: { token: string }) => (await request(app).get('/api/v1/announcements').set(auth(r.token)).expect(200)).body.offers.map((o: any) => o.title) as string[];
  const send = (s: Shop, b: object) => request(app).post('/api/v1/announcements').set(auth(s.d.token)).send({ title: 'Diwali scheme', body: 'Buy 10 get 1 free', ...b });

  it('goes to exactly the retailers picked, and only they see it', async () => {
    const s = await shop();
    const c = s.cats[0].id;
    const A = await retailer(s, [c]); const B = await retailer(s, [c]); const C = await retailer(s, [c]);
    const out = await send(s, { audience: 'retailers', retailer_ids: [A.id, B.id] }).expect(201);
    expect(out.body.recipients).toBe(2);
    expect(await feed(A)).toEqual(['Diwali scheme']); expect(await feed(B)).toEqual(['Diwali scheme']); expect(await feed(C)).toEqual([]);
    expect((await request(app).get('/api/v1/announcements/audience').query({ audience: 'retailers', retailer_ids: `${A.id},${C.id}` }).set(auth(s.d.token)).expect(200)).body.recipients).toBe(2);
  });

  it('can go to all the retailers under one team member', async () => {
    const s = await shop();
    const c = s.cats[0].id;
    const mkRep = async () => { const p = phone(); const e = (await request(app).post('/api/v1/distributor/employees').set(auth(s.d.token)).send({ phone: p, name: 'Rep', password: 'password123' }).expect(201)).body; return { id: e.id as number, token: await login(p) }; };
    const r1 = await mkRep(); const r2 = await mkRep();
    const mine1 = await retailer(s, [c], {}, r1.token); const mine1b = await retailer(s, [c], {}, r1.token); const mine2 = await retailer(s, [c], {}, r2.token); const direct = await retailer(s, [c]);
    expect((await send(s, { audience: 'employee', employee_id: r1.id }).expect(201)).body.recipients).toBe(2);
    expect(await feed(mine1)).toEqual(['Diwali scheme']); expect(await feed(mine1b)).toEqual(['Diwali scheme']);
    expect(await feed(mine2)).toEqual([]); expect(await feed(direct)).toEqual([]);
  });

  it('cannot reach retailers who are not this distributor\'s, or a team member who is not theirs', async () => {
    const s = await shop(); const other = await shop();
    const mine = await retailer(s, [s.cats[0].id]); const theirs = await retailer(other, [other.cats[0].id]);
    expect((await send(s, { audience: 'retailers', retailer_ids: [theirs.id] })).body.error.code).toBe('NO_RECIPIENTS');
    expect((await send(s, { audience: 'retailers', retailer_ids: [theirs.id, mine.id] }).expect(201)).body.recipients).toBe(1);
    const p = phone();
    const foreign = (await request(app).post('/api/v1/distributor/employees').set(auth(other.d.token)).send({ phone: p, name: 'Rep', password: 'password123' }).expect(201)).body;
    expect((await send(s, { audience: 'employee', employee_id: foreign.id })).body.error.code).toBe('BAD_EMPLOYEE');
    expect((await send(s, { audience: 'retailers' })).status).toBe(400);
    expect((await send(s, { audience: 'employee' })).status).toBe(400);
    expect(await feed(theirs)).toEqual([]);
  });

  it('the older audiences still work', async () => {
    const s = await shop();
    const A = await retailer(s, [s.cats[0].id]);
    expect((await send(s, { audience: 'all' }).expect(201)).body.recipients).toBe(1);
    expect((await send(s, { audience: 'pincodes', pincodes: ['400001'], title: 'Local' }).expect(201)).body.recipients).toBe(1);
    expect((await feed(A)).sort()).toEqual(['Diwali scheme', 'Local']);
  });
});

describe('the onboarding employee reviews the distributor\'s products', () => {
  it('products wait for the employee, are hidden from retailers, and appear once approved', async () => {
    const s = await shop({ review_required: undefined });                          // an employee who can review gets review on by default
    expect((await request(app).get('/api/v1/distributor/me').set(auth(s.d.token)).expect(200)).body.review_required).toBe(true);
    const R = await retailer(s, [s.cats[0].id]);
    const p = (await request(app).post('/api/v1/catalog').set(auth(s.d.token)).send({ name: 'New Cola', price: '40', stock_qty: 20, category_id: s.cats[0].id })).body;
    expect(p.review_status).toBe('pending');
    expect((await store(R, s.d.id)).products).toEqual([]);
    expect((await order(R, s.d.id, p.id)).status).toBe(400);

    const queue = (await request(app).get('/api/v1/staff/product-review').set(auth(s.e.token)).expect(200)).body.products;
    expect(queue.map((x: any) => x.id)).toEqual([p.id]);
    expect(queue[0]).toMatchObject({ name: 'New Cola', distributor: expect.any(String) });
    await request(app).post(`/api/v1/staff/products/${p.id}/review`).set(auth(s.e.token)).send({ action: 'approve' }).expect(200);
    expect((await store(R, s.d.id)).products.map((x: any) => x.name)).toEqual(['New Cola']);
    expect((await order(R, s.d.id, p.id)).status).toBe(201);
    expect((await request(app).get('/api/v1/staff/product-review').set(auth(s.e.token))).body.products).toEqual([]);
  });

  it('a rejection needs a reason and the distributor sees it; fixing resubmits', async () => {
    const s = await shop({ review_required: undefined });
    const p = (await request(app).post('/api/v1/catalog').set(auth(s.d.token)).send({ name: 'Odd Thing', price: '9', stock_qty: 5, category_id: s.cats[0].id })).body;
    expect((await request(app).post(`/api/v1/staff/products/${p.id}/review`).set(auth(s.e.token)).send({ action: 'reject' })).body.error.code).toBe('NOTE_REQUIRED');
    await request(app).post(`/api/v1/staff/products/${p.id}/review`).set(auth(s.e.token)).send({ action: 'reject', note: 'Add the HSN code' }).expect(200);
    const mine = (await request(app).get('/api/v1/catalog').set(auth(s.d.token))).body.products.find((x: any) => x.id === p.id);
    expect(mine).toMatchObject({ review_status: 'rejected', review_note: 'Add the HSN code' });
    const fixed = (await request(app).patch(`/api/v1/catalog/${p.id}`).set(auth(s.d.token)).send({ hsn: '1101' }).expect(200)).body;
    expect(fixed.review_status).toBe('pending');
  });

  it('only the employee who onboarded the distributor can review its products (or the admin)', async () => {
    const s = await shop({ review_required: undefined });
    const stranger = await employee(s.a);
    const noPower = await employee(s.a, ['create_distributors']);
    const p = (await request(app).post('/api/v1/catalog').set(auth(s.d.token)).send({ name: 'Guarded', price: '9', stock_qty: 5 })).body;
    expect((await request(app).post(`/api/v1/staff/products/${p.id}/review`).set(auth(stranger.token)).send({ action: 'approve' })).status).toBe(404);
    expect((await request(app).get('/api/v1/staff/product-review').set(auth(stranger.token)).expect(200)).body.products).toEqual([]);
    expect((await request(app).get('/api/v1/staff/product-review').set(auth(noPower.token))).status).toBe(403);
    expect((await request(app).post(`/api/v1/staff/products/${p.id}/review`).set(auth(s.d.token)).send({ action: 'approve' })).status).toBe(403);
    await request(app).post(`/api/v1/admin/products/${p.id}/review`).set(auth(s.a.token)).send({ action: 'approve' }).expect(200);
  });

  it('an employee without the review power onboards distributors whose products go live at once', async () => {
    const a = await admin(); const e = await employee(a, ['create_distributors']);
    const d = await onboardDistributor(app, a, e, { review_required: true });                // asking for review without the power does nothing
    expect((await request(app).get('/api/v1/distributor/me').set(auth(d.token)).expect(200)).body.review_required).toBe(false);
    const p = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Live at once', price: '9', stock_qty: 5 })).body;
    expect(p.review_status).toBe('approved');
  });

  it('the employee can turn review off or on for their distributor', async () => {
    const s = await shop({ review_required: undefined });
    await request(app).put(`/api/v1/staff/distributors/${s.d.id}`).set(auth(s.e.token)).send({ review_required: false }).expect(200);
    expect((await request(app).post('/api/v1/catalog').set(auth(s.d.token)).send({ name: 'Free', price: '9', stock_qty: 5 })).body.review_status).toBe('approved');
    const lim = await employee(s.a, ['create_distributors', 'manage_distributors']);
    const own = await onboardDistributor(app, s.a, lim);
    expect((await request(app).put(`/api/v1/staff/distributors/${own.id}`).set(auth(lim.token)).send({ review_required: true })).status).toBe(403);
  });
});

describe('an employee sees the reports of the distributors mapped to them, and nobody else\'s', () => {
  async function trade(s: Shop) {
    const p = await product(s, 'Cola', s.cats[0].id);
    const R = await retailer(s, [s.cats[0].id]);
    const o = (await order(R, s.d.id, p.id)).body.order;
    return { p, R, o };
  }
  const analytics = (t: string, qs = '') => request(app).get(`/api/v1/staff/team/analytics${qs}`).set(auth(t));

  it('analytics cover only the employee\'s own distributors', async () => {
    const a = await admin(); const e1 = await employee(a); const e2 = await employee(a);
    const cats = [await makeCategory(app, a.token, 'Shared ' + ++k)];
    const mine = await onboardDistributor(app, a, e1, { category_ids: [cats[0].id], review_required: false });
    const theirs = await onboardDistributor(app, a, e2, { category_ids: [cats[0].id], review_required: false });
    const s1: Shop = { a, e: e1, d: mine, cats }; const s2: Shop = { a, e: e2, d: theirs, cats };
    await trade(s1); await trade(s2); await trade(s2);

    const k1 = (await analytics(e1.token).expect(200)).body;
    expect(k1.kpis.total_orders).toBe(1);
    expect(k1.range.distributors_in_scope).toBe(1);
    expect((await analytics(e2.token).expect(200)).body.kpis.total_orders).toBe(2);
    expect((await request(app).get('/api/v1/admin/analytics').set(auth(a.token)).expect(200)).body.kpis.total_orders).toBeGreaterThanOrEqual(3);
    expect(k1.series.distributor_performance.map((x: any) => x.distributor_id)).toEqual([mine.id]);

    // asking about someone else's distributor is refused
    expect((await analytics(e1.token, `?distributor_id=${theirs.id}`)).status).toBe(403);
    expect((await analytics(e1.token, `?distributor_id=${mine.id}`).expect(200)).body.kpis.total_orders).toBe(1);
  });

  it('an employee with no distributors yet sees zeros, not everyone\'s numbers', async () => {
    const a = await admin(); const lonely = await employee(a);
    const other = await employee(a);
    const cats = [await makeCategory(app, a.token, 'Alone ' + ++k)];
    const od = await onboardDistributor(app, a, other, { category_ids: [cats[0].id], review_required: false });
    await trade({ a, e: other, d: od, cats });
    const out = (await analytics(lonely.token).expect(200)).body;
    expect(out.kpis).toMatchObject({ total_orders: 0, gmv: '0.00', total_products: 0 });
  });

  it('needs the view_team_reports power', async () => {
    const a = await admin(); const e = await employee(a, ['create_distributors']);
    expect((await analytics(e.token)).status).toBe(403);
    expect((await request(app).post('/api/v1/staff/team/reports').set(auth(e.token)).send({ type: 'orders' })).status).toBe(403);
  });

  it('report exports contain only their distributors\' rows, and are private to the requester', async () => {
    const a = await admin(); const e1 = await employee(a); const e2 = await employee(a);
    const cats = [await makeCategory(app, a.token, 'Export ' + ++k)];
    const mine = await onboardDistributor(app, a, e1, { category_ids: [cats[0].id], review_required: false, business_name: 'Mine Traders' });
    const theirs = await onboardDistributor(app, a, e2, { category_ids: [cats[0].id], review_required: false, business_name: 'Theirs Traders' });
    await trade({ a, e: e1, d: mine, cats }); await trade({ a, e: e2, d: theirs, cats });

    const made = (await request(app).post('/api/v1/staff/team/reports').set(auth(e1.token)).send({ type: 'orders', format: 'csv' }).expect(202)).body;
    let job = made;
    for (let i = 0; i < 100 && job.status !== 'done' && job.status !== 'failed'; i++) { await new Promise((r) => setTimeout(r, 50)); job = (await request(app).get(`/api/v1/staff/team/reports/${made.id}`).set(auth(e1.token)).expect(200)).body; }
    expect(job).toMatchObject({ status: 'done', row_count: 1 });
    const csv = (await request(app).get(`/api/v1/staff/team/reports/${made.id}/download`).set(auth(e1.token)).expect(200)).text;
    expect(csv).toContain('Mine Traders');
    expect(csv).not.toContain('Theirs Traders');
    expect((await request(app).get(`/api/v1/staff/team/reports/${made.id}/download`).set(auth(e2.token))).status).toBe(404);
    expect((await request(app).post('/api/v1/staff/team/reports').set(auth(e1.token)).send({ type: 'orders', distributor_id: theirs.id })).status).toBe(403);

    const dists = (await request(app).post('/api/v1/staff/team/reports').set(auth(e1.token)).send({ type: 'distributors' }).expect(202)).body;
    let j2 = dists;
    for (let i = 0; i < 100 && j2.status !== 'done' && j2.status !== 'failed'; i++) { await new Promise((r) => setTimeout(r, 50)); j2 = (await request(app).get(`/api/v1/staff/team/reports/${dists.id}`).set(auth(e1.token)).expect(200)).body; }
    expect(j2.row_count).toBe(1);
  });

  it('the commission report is limited to their distributors too', async () => {
    const a = await admin(); const e = await employee(a, [...POWERS, 'view_commissions']); const other = await employee(a);
    const cats = [await makeCategory(app, a.token, 'Comm ' + ++k)];
    await onboardDistributor(app, a, e, { category_ids: [cats[0].id], review_required: false });
    await onboardDistributor(app, a, other, { category_ids: [cats[0].id], review_required: false });
    expect((await request(app).get('/api/v1/staff/commissions').set(auth(e.token)).expect(200)).body.commissions).toEqual([]);
  });
});
