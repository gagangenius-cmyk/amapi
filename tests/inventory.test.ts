import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7600000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = (await request(app).post('/api/v1/auth/register').send(body).expect(201)).body;
  return { id: r.id as number, token: r.access_token as string, phone: p };
}
const link = async (d: { id: number; token: string }, r: { phone: string; token: string }) => {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
};
async function setup(stock = 10) {
  const d = await reg('distributor'); const r = await reg('retailer');
  await link(d, r);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', stock_qty: stock, gst_rate_bps: 0 })).body.id as number;
  return { d, r, pid };
}
let k = 0;
const place = (r: { token: string }, did: number, pid: number, qty: number) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'inv' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty }] });
const move = (d: { token: string }, oid: number, to: string) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to });
const pos = async (d: { token: string }, pid: number) =>
  (await request(app).get('/api/v1/inventory/positions').set(auth(d.token)).expect(200)).body.positions.find((p: any) => p.product_id === pid);
const warehouses = async (d: { token: string }) => (await request(app).get('/api/v1/inventory/warehouses').set(auth(d.token)).expect(200)).body.warehouses as any[];
const clean = async (d: { token: string }) => (await request(app).get('/api/v1/inventory/reconciliation').set(auth(d.token)).expect(200)).body;

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('reservations: what is promised cannot be promised again', () => {
  it('stock promised to a waiting order is not available to the next one', async () => {
    const { d, r, pid } = await setup(5);
    const r2 = await reg('retailer'); await link(d, r2);
    await place(r, d.id, pid, 3).expect(201);
    const second = await place(r2, d.id, pid, 3);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('OUT_OF_STOCK');
    expect(second.body.error.details?.available ?? second.body.error.available).toBe(2);
    await place(r2, d.id, pid, 2).expect(201);

    const p = await pos(d, pid);
    expect(p).toMatchObject({ on_hand: 5, reserved: 5, available: 0, committed: 0, in_transit: 0 });
  });

  it('rejecting an order gives the promise back', async () => {
    const { d, r, pid } = await setup(5);
    const o = (await place(r, d.id, pid, 4).expect(201)).body.order.id;
    expect(await pos(d, pid)).toMatchObject({ reserved: 4, available: 1 });
    await move(d, o, 'rejected').expect(200);
    expect(await pos(d, pid)).toMatchObject({ reserved: 0, available: 5, on_hand: 5 });
    await place(r, d.id, pid, 5).expect(201);
  });

  it('parallel orders for the same product can never promise more than there is', async () => {
    const { d, r, pid } = await setup(10);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => place(r, d.id, pid, 3)));
    const ok = results.filter((x) => x.status === 201).length;
    const refused = results.filter((x) => x.status === 409 && x.body.error.code === 'OUT_OF_STOCK').length;
    expect(ok).toBe(3);               // 3 x 3 = 9 <= 10; a fourth would be 12
    expect(refused).toBe(2);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 10, reserved: 9, available: 1 });
  });

  it('an order moves through the buckets as it is accepted and shipped', async () => {
    const { d, r, pid } = await setup(10);
    const o = (await place(r, d.id, pid, 4).expect(201)).body.order.id;
    expect(await pos(d, pid)).toMatchObject({ on_hand: 10, reserved: 4, committed: 0, in_transit: 0, available: 6 });
    await move(d, o, 'accepted').expect(200);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 6, reserved: 0, committed: 4, in_transit: 0, available: 6 });
    await move(d, o, 'dispatched').expect(200);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 6, committed: 0, in_transit: 4 });
    await move(d, o, 'out_for_delivery').expect(200);
    await move(d, o, 'delivered').expect(200);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 6, reserved: 0, committed: 0, in_transit: 0, available: 6 });
    expect((await clean(d)).clean).toBe(true);
  });

  it('the catalogue shows reserved and available quantities', async () => {
    const { d, r, pid } = await setup(8);
    await place(r, d.id, pid, 3).expect(201);
    const row = (await request(app).get('/api/v1/catalog').set(auth(d.token)).expect(200)).body.products.find((x: any) => x.id === pid);
    expect(row).toMatchObject({ stock_qty: 8, reserved_qty: 3, available_qty: 5 });
  });
});

describe('warehouses', () => {
  it('every distributor has a default warehouse holding the stock', async () => {
    const { d, pid } = await setup(10);
    const w = await warehouses(d);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ name: 'Main warehouse', is_default: true, units: 10 });
    expect((await pos(d, pid)).warehouses).toEqual([expect.objectContaining({ name: 'Main warehouse', qty: 10 })]);
  });

  it('transfers move stock between warehouses without changing the total, and are recorded', async () => {
    const { d, pid } = await setup(10);
    const wh = (await request(app).post('/api/v1/inventory/warehouses').set(auth(d.token)).send({ name: 'Godown 2', address: 'Bhiwandi' }).expect(201)).body;
    const main = (await warehouses(d)).find((x) => x.is_default).id;
    await request(app).post('/api/v1/inventory/transfers').set(auth(d.token)).send({ product_id: pid, from_warehouse_id: main, to_warehouse_id: wh.id, qty: 4, note: 'Fast mover' }).expect(201);

    const p = await pos(d, pid);
    expect(p.on_hand).toBe(10);
    expect(p.warehouses.map((x: any) => [x.name, x.qty])).toEqual([['Main warehouse', 6], ['Godown 2', 4]]);
    const mv = (await request(app).get('/api/v1/inventory/movements').query({ product_id: pid }).set(auth(d.token)).expect(200)).body.movements;
    expect(mv.slice(0, 2).map((m: any) => [m.reason, m.delta, m.warehouse])).toEqual([['transfer_in', 4, 'Godown 2'], ['transfer_out', -4, 'Main warehouse']]);
    expect((await clean(d)).clean).toBe(true);

    // more than is there, same warehouse, or someone else's warehouse
    expect((await request(app).post('/api/v1/inventory/transfers').set(auth(d.token)).send({ product_id: pid, from_warehouse_id: wh.id, to_warehouse_id: main, qty: 5 })).body.error.code).toBe('NOT_ENOUGH_HERE');
    expect((await request(app).post('/api/v1/inventory/transfers').set(auth(d.token)).send({ product_id: pid, from_warehouse_id: main, to_warehouse_id: main, qty: 1 })).status).toBe(400);
    const other = await reg('distributor');
    const theirs = (await warehouses(other))[0].id;
    expect((await request(app).post('/api/v1/inventory/transfers').set(auth(d.token)).send({ product_id: pid, from_warehouse_id: main, to_warehouse_id: theirs, qty: 1 })).status).toBe(404);
  });

  it('new stock goes where it is told, and orders draw from the default warehouse first', async () => {
    const { d, r, pid } = await setup(2);
    const wh = (await request(app).post('/api/v1/inventory/warehouses').set(auth(d.token)).send({ name: 'Cold store' }).expect(201)).body;
    await request(app).post(`/api/v1/catalog/${pid}/stock`).set(auth(d.token)).send({ delta: 5, warehouse_id: wh.id }).expect(200);
    expect((await pos(d, pid)).warehouses.map((x: any) => [x.name, x.qty])).toEqual([['Main warehouse', 2], ['Cold store', 5]]);

    const o = (await place(r, d.id, pid, 4).expect(201)).body.order.id;
    await move(d, o, 'accepted').expect(200);
    expect((await pos(d, pid)).warehouses.map((x: any) => [x.name, x.qty])).toEqual([['Cold store', 3]]);   // main emptied first
    expect((await pos(d, pid)).on_hand).toBe(3);
    expect((await clean(d)).clean).toBe(true);
  });

  it('a warehouse with stock cannot be switched off, nor the default one', async () => {
    const { d } = await setup(3);
    const main = (await warehouses(d))[0];
    expect((await request(app).put(`/api/v1/inventory/warehouses/${main.id}`).set(auth(d.token)).send({ is_active: false })).body.error.code).toBe('IS_DEFAULT');
    const w2 = (await request(app).post('/api/v1/inventory/warehouses').set(auth(d.token)).send({ name: 'Second' }).expect(201)).body;
    await request(app).put(`/api/v1/inventory/warehouses/${w2.id}`).set(auth(d.token)).send({ is_default: true }).expect(200);
    expect((await request(app).put(`/api/v1/inventory/warehouses/${main.id}`).set(auth(d.token)).send({ is_active: false })).body.error.code).toBe('NOT_EMPTY');
    expect((await request(app).post('/api/v1/inventory/warehouses').set(auth(d.token)).send({ name: ' second ' })).status).toBe(409);
  });
});

describe('damaged stock', () => {
  it('leaves sellable stock at once, can be recovered or written off, and always reconciles', async () => {
    const { d, r, pid } = await setup(10);
    await request(app).post('/api/v1/inventory/damaged').set(auth(d.token)).send({ product_id: pid, qty: 3, note: 'Water damage' }).expect(201);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 7, damaged: 3, available: 7 });
    expect((await place(r, d.id, pid, 8)).status).toBe(409);               // the 3 damaged units cannot be sold
    await place(r, d.id, pid, 7).expect(201);
    expect((await clean(d)).clean).toBe(true);

    await request(app).post('/api/v1/inventory/damaged/recover').set(auth(d.token)).send({ product_id: pid, qty: 1 }).expect(201);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 8, damaged: 2 });
    await request(app).post('/api/v1/inventory/damaged/write-off').set(auth(d.token)).send({ product_id: pid, qty: 2, note: 'Binned' }).expect(201);
    expect(await pos(d, pid)).toMatchObject({ on_hand: 8, damaged: 0 });
    expect((await request(app).post('/api/v1/inventory/damaged/write-off').set(auth(d.token)).send({ product_id: pid, qty: 1 })).body.error.code).toBe('NOT_ENOUGH_DAMAGED');
    expect((await request(app).post('/api/v1/inventory/damaged').set(auth(d.token)).send({ product_id: pid, qty: 99 })).body.error.code).toBe('OUT_OF_STOCK');

    const mv = (await request(app).get('/api/v1/inventory/movements').query({ product_id: pid }).set(auth(d.token)).expect(200)).body.movements;
    expect(mv.filter((m: any) => m.bucket === 'damaged').map((m: any) => [m.reason, m.delta])).toEqual([['damaged_writeoff', -2], ['damaged_recovered', -1], ['damaged', 3]]);
    expect((await clean(d)).clean).toBe(true);
  });
});

describe('reconciliation', () => {
  it('finds stock that was changed behind the ledger\'s back', async () => {
    const { d, pid } = await setup(10);
    expect((await clean(d)).clean).toBe(true);
    await exec(pool, 'UPDATE products SET stock_qty = stock_qty + 5 WHERE id = ?', [pid]);   // what a bad script or manual SQL would do
    const rec = await clean(d);
    expect(rec.clean).toBe(false);
    expect(rec.issues[0]).toMatchObject({ product_id: pid, stock_qty: 15, warehouse_qty: 10, ledger_qty: 10 });
    expect(rec.issues[0].problems.join(' ')).toMatch(/warehouses hold 10 but stock is 15/);
    expect(rec.issues[0].problems.join(' ')).toMatch(/ledger adds up to 10/);
  });

  it('a counted correction brings a drifted product back in line', async () => {
    const { d, pid } = await setup(10);
    await exec(pool, 'UPDATE products SET stock_qty = 14 WHERE id = ?', [pid]);
    await request(app).post(`/api/v1/catalog/${pid}/stock`).set(auth(d.token)).send({ set_to: 10, expected: 14, note: 'Physical count' }).expect(200);
    expect((await clean(d)).clean).toBe(true);
    expect((await pos(d, pid)).on_hand).toBe(10);
  });

  it('is private to the distributor', async () => {
    const a = await setup(5); const b = await setup(5);
    await exec(pool, 'UPDATE products SET stock_qty = 99 WHERE id = ?', [a.pid]);
    expect((await clean(b.d)).clean).toBe(true);
    expect((await clean(a.d)).clean).toBe(false);
  });
});

describe('valuation and cost', () => {
  it('values stock at cost and at selling price, and says when cost is missing', async () => {
    const { d, pid } = await setup(10);                       // Rice: price 100, stock 10, no cost yet
    const other = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Oil', price: '200', stock_qty: 4, gst_rate_bps: 0, cost: '150' }).expect(201)).body;
    let s = (await request(app).get('/api/v1/inventory/summary').set(auth(d.token)).expect(200)).body;
    expect(s).toMatchObject({ products: 2, on_hand: 14 });
    expect(s.valuation).toMatchObject({ at_selling_price: '1800.00', at_cost: '600.00', products_without_cost: 1, complete: false });

    await request(app).patch(`/api/v1/catalog/${pid}`).set(auth(d.token)).send({ cost: '70' }).expect(200);
    s = (await request(app).get('/api/v1/inventory/summary').set(auth(d.token)).expect(200)).body;
    expect(s.valuation).toMatchObject({ at_cost: '1300.00', products_without_cost: 0, complete: true });
    expect((await pos(d, other.id)).value_at_cost).toBe('600.00');

    // the cost is recorded in the product's history
    const v = (await request(app).get(`/api/v1/catalog/${pid}/versions`).set(auth(d.token)).expect(200)).body.versions;
    expect(v[0].changes.cost).toEqual({ from: null, to: '70.00' });
  });

  it('cost is never shown to retailers', async () => {
    const { d, r } = await setup(5);
    await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Sugar', price: '50', stock_qty: 5, cost: '35' }).expect(201);
    const list = (await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(r.token)).expect(200)).body.products as any[];
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toMatch(/cost/i);
  });
});

describe('access', () => {
  it('only the distributor owner can use the inventory book', async () => {
    const { d, r } = await setup(5);
    for (const url of ['/api/v1/inventory/summary', '/api/v1/inventory/positions', '/api/v1/inventory/warehouses', '/api/v1/inventory/reconciliation']) {
      expect((await request(app).get(url).set(auth(r.token))).status).toBe(403);
      expect((await request(app).get(url)).status).toBe(401);
    }
    const ep = phone();
    await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: ep, name: 'Packer', password: 'password123' }).expect(201);
    const et = (await request(app).post('/api/v1/auth/login').send({ phone: ep, password: 'password123' })).body.access_token;
    expect((await request(app).get('/api/v1/inventory/summary').set(auth(et))).status).toBe(403);
  });

  it('survives an unused admin account existing alongside', async () => {
    const p = phone();
    await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'A', await bcrypt.hash('password123', 4)]);
    const row = await q1<any>(pool, "SELECT COUNT(*) n FROM warehouses");
    expect(Number(row!.n)).toBeGreaterThan(0);
  });
});
