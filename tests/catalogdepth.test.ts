import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool, q, q1 } from '../src/db/pool';
import { runBatchExpiryAlerts } from '../src/jobs/subscriptionWarnings';

const app = createApp();
let n = 0;
const phone = () => String(7800000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
async function setup() {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  return { d, r };
}
const product = async (d: { token: string }, extra: object = {}) =>
  (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Milk', price: '50', stock_qty: 0, ...extra }).expect(201)).body;
let k = 0;
const order = (r: { token: string }, did: number, pid: number, qty: number) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'cd-' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty }] });
const move = (d: { token: string }, oid: number, to: string) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to });
const batch = (d: { token: string }, pid: number, body: object) => request(app).post(`/api/v1/catalog/${pid}/batches`).set(auth(d.token)).send(body);
const stock = async (pid: number) => (await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty;
const remaining = async (pid: number) => (await q<any>(pool, 'SELECT batch_no, qty_remaining FROM product_batches WHERE product_id = ? ORDER BY id', [pid])).map((b) => `${b.batch_no}:${b.qty_remaining}`);

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('barcodes', () => {
  it('finds a product by barcode, keeps barcodes unique per distributor, and frees them on delete', async () => {
    const { d } = await setup(); const other = await reg('distributor');
    const p = await product(d, { barcode: '8901234567890' });
    expect(p.barcode).toBe('8901234567890');
    const hit = await request(app).get('/api/v1/catalog/lookup').query({ barcode: '8901234567890' }).set(auth(d.token)).expect(200);
    expect(hit.body.id).toBe(p.id);
    await request(app).get('/api/v1/catalog/lookup').query({ barcode: '8901234567890' }).set(auth(other.token)).expect(404);   // not someone else's
    expect((await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Dup', price: '1', barcode: '8901234567890' })).body.error.code).toBe('BARCODE_TAKEN');
    await product(other, { barcode: '8901234567890' });                                                                          // different distributor: fine
    expect((await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Bad', price: '1', barcode: 'a b' })).status).toBe(400);
    expect((await request(app).get('/api/v1/catalog').query({ q: '8901234567890' }).set(auth(d.token))).body.products).toHaveLength(1);
    await request(app).delete(`/api/v1/catalog/${p.id}`).set(auth(d.token)).expect(204);
    await product(d, { barcode: '8901234567890' });
  });
});

describe('variants', () => {
  it('groups sizes under one name, and the order keeps the full variant name', async () => {
    const { d, r } = await setup();
    const small = await product(d, { name: 'Basmati Rice', variant_group: 'Basmati Rice', variant_label: '1 kg', price: '100', stock_qty: 10 });
    await product(d, { name: 'Basmati Rice', variant_group: 'Basmati Rice', variant_label: '5 kg', price: '450', stock_qty: 10 });
    expect(small.display_name).toBe('Basmati Rice · 1 kg');
    const shop = (await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(r.token)).expect(200)).body.products;
    expect(shop.map((x: any) => x.display_name)).toEqual(['Basmati Rice · 1 kg', 'Basmati Rice · 5 kg']);
    const oid = (await order(r, d.id, small.id, 2).expect(201)).body.order.id;
    expect((await request(app).get(`/api/v1/orders/${oid}`).set(auth(r.token))).body.items[0].name).toBe('Basmati Rice · 1 kg');
  });
});

describe('batches and expiry', () => {
  it('sells the earliest-expiring batch first and never an expired one', async () => {
    const { d, r } = await setup();
    const p = await product(d);
    await batch(d, p.id, { batch_no: 'LATE', qty: 10, expiry_date: day(90) }).expect(201);
    await batch(d, p.id, { batch_no: 'SOON', qty: 10, expiry_date: day(10) }).expect(201);
    await batch(d, p.id, { batch_no: 'DEAD', qty: 5, expiry_date: day(-3) }).expect(201);
    expect(await stock(p.id)).toBe(25);

    const o1 = (await order(r, d.id, p.id, 12).expect(201)).body.order.id;
    await move(d, o1, 'accepted').expect(200);
    expect(await remaining(p.id)).toEqual(['LATE:8', 'SOON:0', 'DEAD:5']);     // SOON (10) then 2 from LATE; DEAD untouched
    expect(await stock(p.id)).toBe(13);

    // only 8 unexpired units remain; the 5 expired ones must not cover the rest
    const o2 = (await order(r, d.id, p.id, 9).expect(201)).body.order.id;
    const bad = await move(d, o2, 'accepted');
    expect(bad.status).toBe(409); expect(bad.body.error.code).toBe('EXPIRED_STOCK');
    expect(await stock(p.id)).toBe(13);                                         // rolled back completely
    expect(await remaining(p.id)).toEqual(['LATE:8', 'SOON:0', 'DEAD:5']);

    // cancelling puts the goods back in the same batches
    await move(d, o1, 'cancelled').expect(200);
    expect(await remaining(p.id)).toEqual(['LATE:10', 'SOON:10', 'DEAD:5']);
    expect(await stock(p.id)).toBe(25);
  });

  it('lists what is expiring, writes off an expired batch, and keeps stock history', async () => {
    const { d } = await setup(); const other = await reg('distributor');
    const p = await product(d);
    await batch(d, p.id, { batch_no: 'OLD', qty: 6, expiry_date: day(-1) }).expect(201);
    const fine = await batch(d, p.id, { batch_no: 'OK', qty: 4, expiry_date: day(200) }).expect(201);
    const soon = await request(app).get('/api/v1/catalog/expiring').query({ days: 30 }).set(auth(d.token)).expect(200);
    expect(soon.body.batches).toHaveLength(1);
    expect(soon.body.batches[0]).toMatchObject({ batch_no: 'OLD', qty: 6, expired: true });

    const bid = soon.body.batches[0].id;
    await request(app).post(`/api/v1/catalog/${p.id}/batches/${bid}/write-off`).set(auth(other.token)).send({}).expect(404);
    const wo = await request(app).post(`/api/v1/catalog/${p.id}/batches/${bid}/write-off`).set(auth(d.token)).send({ reason: 'Expired' }).expect(200);
    expect(wo.body).toMatchObject({ written_off: 6, stock_qty: 4 });
    await request(app).post(`/api/v1/catalog/${p.id}/batches/${bid}/write-off`).set(auth(d.token)).send({}).expect(409);
    const detail = (await request(app).get(`/api/v1/catalog/${p.id}`).set(auth(d.token))).body;
    expect(detail.batches.map((b: any) => `${b.batch_no}:${b.qty_remaining}`)).toEqual(['OLD:0', 'OK:4']);
    expect(detail.stock_history[0].note).toContain('Expired: batch OLD');
    expect(fine.body.stock_qty).toBe(10);
  });

  it('a manual stock reduction shrinks the latest-expiring batch so the books agree', async () => {
    const { d } = await setup();
    const p = await product(d);
    await batch(d, p.id, { batch_no: 'A', qty: 5, expiry_date: day(10) });
    await batch(d, p.id, { batch_no: 'B', qty: 5, expiry_date: day(50) });
    await request(app).post(`/api/v1/catalog/${p.id}/stock`).set(auth(d.token)).send({ delta: -7, note: 'spillage' }).expect(200);
    expect(await remaining(p.id)).toEqual(['A:3', 'B:0']);   // stock fell 10 -> 3: B (expires last) gives up all 5, A gives up 2
  });

  it('products without batches behave exactly as before', async () => {
    const { d, r } = await setup();
    const p = await product(d, { stock_qty: 5 });
    const oid = (await order(r, d.id, p.id, 5).expect(201)).body.order.id;
    await move(d, oid, 'accepted').expect(200);
    expect(await stock(p.id)).toBe(0);
  });

  it('alerts the distributor once a day about expired and expiring batches', async () => {
    const { d } = await setup();
    const p = await product(d);
    await batch(d, p.id, { batch_no: 'X', qty: 1, expiry_date: day(3) });
    expect(await runBatchExpiryAlerts(14)).toBeGreaterThanOrEqual(1);
  });
});
