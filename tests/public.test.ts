import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(8200000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function distributor() {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@c.test`, name: 'Owner', password: 'password123', business_name: 'Public Biz ' + p });
  return { id: r.body.id as number, token: r.body.access_token as string };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('the public shop window', () => {
  it('lists published products without a login, with list prices, capped stock and no private data', async () => {
    const d = await distributor();
    const made = await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Public Widget', price: '100', mrp: '150', gst_rate_bps: 1800, stock_qty: 500, cost: '60', brand: 'Acme', category: 'Widgets' }).expect(201);
    expect(made.body.id).toBeGreaterThan(0);

    const r = (await request(app).get('/api/v1/public/products').query({ q: 'Public Widget' }).expect(200)).body;
    const p = r.products.find((x: any) => x.id === made.body.id);
    expect(p).toBeTruthy();
    expect(p).toMatchObject({ name: 'Public Widget', price: '100.00', mrp: '150.00', gst_rate_bps: 1800 });
    expect(p.stock_qty).toBe(11);                         // the exact stock is not published
    expect(p.distributor_name).toContain('Public Biz');
    expect(JSON.stringify(r)).not.toMatch(/cost/i);        // the purchase price never leaves
    expect(r.categories).toContain('Widgets');
  });

  it('leaves out hidden products, products kept for chosen retailers, and a switched-off distributor', async () => {
    const d = await distributor();
    const hidden = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Hidden Gadget', price: '50', is_active: false }).expect(201)).body;
    const kept = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Private Gadget', price: '50' }).expect(201)).body;
    const rp = phone();
    const ret = (await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: rp, email: `r${rp}@c.test`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + rp, pincode: '400001' }).expect(201)).body;
    await exec(pool, 'INSERT INTO product_audience (product_id, retailer_id) VALUES (?,?)', [kept.id, ret.id]);

    const ids = (await request(app).get('/api/v1/public/products').query({ q: 'Gadget' }).expect(200)).body.products.map((x: any) => x.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(kept.id);

    const live = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Live Gadget', price: '50' }).expect(201)).body;
    expect((await request(app).get('/api/v1/public/products').query({ q: 'Live Gadget' })).body.products.map((x: any) => x.id)).toContain(live.id);
    await exec(pool, 'UPDATE users SET is_active = 0 WHERE id = ?', [d.id]);
    expect((await request(app).get('/api/v1/public/products').query({ q: 'Live Gadget' })).body.products.map((x: any) => x.id)).not.toContain(live.id);
  });

  it('filters by category and search, and pages the result', async () => {
    const d = await distributor();
    for (const nm of ['Alpha Item', 'Beta Item', 'Gamma Item']) await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: nm, price: '10', category: 'Zed Cat' }).expect(201);
    const all = (await request(app).get('/api/v1/public/products').query({ category: 'Zed Cat' }).expect(200)).body;
    expect(all.total).toBeGreaterThanOrEqual(3);
    const page = (await request(app).get('/api/v1/public/products').query({ category: 'Zed Cat', limit: 2, offset: 0 }).expect(200)).body;
    expect(page.products).toHaveLength(2);
    expect((await request(app).get('/api/v1/public/products').query({ q: 'Beta Item' })).body.products.some((x: any) => x.name === 'Beta Item')).toBe(true);
  });

  it('can be switched off', async () => {
    process.env.PUBLIC_CATALOG = 'off';
    try { expect((await request(app).get('/api/v1/public/products')).status).toBe(404); } finally { delete process.env.PUBLIC_CATALOG; }
  });
});
