import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7000000000 + 500000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function setup() {
  const p = phone();
  const d = (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }).expect(201)).body;
  await request(app).put('/api/v1/distributor/pincodes').set(auth(d.access_token)).send({ pincodes: ['400001'] });
  const rp = phone();
  const r = (await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: rp, email: `r${rp}@t.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + rp, pincode: '400001', address: '4 Lane' }).expect(201)).body;
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.access_token)).send({ phone: rp }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.access_token)).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.access_token)).send({ name: 'Rice', price: '100', stock_qty: 500 })).body.id;
  const emp = async (name: string) => {
    const ep = phone();
    const e = (await request(app).post('/api/v1/distributor/employees').set(auth(d.access_token)).send({ phone: ep, name, password: 'password123' }).expect(201)).body;
    const token = (await request(app).post('/api/v1/auth/login').send({ phone: ep, password: 'password123' })).body.access_token as string;
    return { id: e.id as number, token };
  };
  return { d: { id: d.id as number, token: d.access_token as string }, r: { id: r.id as number, token: r.access_token as string }, pid, emp };
}
let k = 0;
const accepted = async (s: Awaited<ReturnType<typeof setup>>, qty = 1) => {
  const oid = (await request(app).post('/api/v1/orders').set(auth(s.r.token)).set('Idempotency-Key', 'em-' + ++k).send({ distributor_id: s.d.id, items: [{ product_id: s.pid, qty }] }).expect(201)).body.order.id as number;
  await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(s.d.token)).send({ to: 'accepted' }).expect(200);
  return oid;
};
const move = (t: string, oid: number, to: string) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(t)).send({ to });

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('delivery staff', () => {
  it('an assigned employee runs the delivery, updates every status, and collects cash with note counts', async () => {
    const s = await setup(); const e = await s.emp('Delivery One');
    const oid = await accepted(s, 3);                                           // Rs 300
    await request(app).post(`/api/v1/orders/${oid}/assign`).set(auth(s.d.token)).send({ employee_id: e.id }).expect(200);

    expect((await request(app).get('/api/v1/orders').set(auth(e.token))).body.orders.map((o: any) => o.id)).toEqual([oid]);   // sees only theirs
    expect((await move(e.token, oid, 'cancelled')).status).toBe(403);           // a driver can not cancel
    for (const to of ['dispatched', 'out_for_delivery', 'delivered']) await move(e.token, oid, to).expect(200);
    const events = (await request(app).get(`/api/v1/orders/${oid}`).set(auth(s.d.token))).body.events.map((x: any) => x.to_status);
    expect(events).toEqual(['placed', 'accepted', 'dispatched', 'out_for_delivery', 'delivered']);

    // the retailer pays the driver in cash: Rs 200 = 2 x 100, recorded with the note counts
    await request(app).post('/api/v1/ledger/transaction').set(auth(e.token)).set('Idempotency-Key', 'em-cash').send({ retailer_id: s.r.id, transaction_type: 'payment_cash', amount: '200', cash_denominations: { '100': 2 } }).expect(201);
    expect((await request(app).post('/api/v1/ledger/transaction').set(auth(e.token)).set('Idempotency-Key', 'em-bad').send({ retailer_id: s.r.id, transaction_type: 'payment_cash', amount: '100', cash_denominations: { '50': 1 } })).status).toBe(400);   // counts must add up
    const inv = (await request(app).get('/api/v1/ledger/invoices').query({ retailer_id: s.r.id }).set(auth(e.token))).body;
    expect(inv.totals).toMatchObject({ invoiced: '300.00', received: '200.00', outstanding: '100.00' });
    expect((await request(app).get(`/api/v1/orders/${oid}`).set(auth((await s.emp('Other Guy')).token))).status).toBe(404);   // a colleague can not open it
  });

  it('shows each person\'s workload and a delivery board for tracking', async () => {
    const s = await setup(); const a = await s.emp('Asha'); const b = await s.emp('Bala');
    const o1 = await accepted(s); const o2 = await accepted(s); const o3 = await accepted(s);
    await request(app).post(`/api/v1/orders/${o1}/assign`).set(auth(s.d.token)).send({ employee_id: a.id }).expect(200);
    await request(app).post(`/api/v1/orders/${o2}/assign`).set(auth(s.d.token)).send({ employee_id: a.id }).expect(200);
    await move(a.token, o2, 'dispatched').expect(200);

    const team = (await request(app).get('/api/v1/distributor/employees').set(auth(s.d.token))).body.employees;
    expect(team.find((x: any) => x.id === a.id)).toMatchObject({ open_orders: 2, delivered_today: 0, is_available: true });
    expect(team.find((x: any) => x.id === b.id).open_orders).toBe(0);

    const board = (await request(app).get('/api/v1/distributor/deliveries').set(auth(s.d.token)).expect(200)).body;
    expect(board.unassigned.map((o: any) => o.id)).toEqual([o3]);
    const mineA = board.by_employee.find((x: any) => x.employee.id === a.id).orders;
    expect(mineA.map((o: any) => [o.id, o.status])).toEqual([[o1, 'accepted'], [o2, 'dispatched']]);
    expect(mineA[0]).toMatchObject({ shop_name: expect.stringContaining('Shop'), pincode: '400001', address: '4 Lane', total: '100.00' });

    for (const to of ['out_for_delivery', 'delivered']) await move(a.token, o2, to).expect(200);
    expect((await request(app).get('/api/v1/distributor/employees').set(auth(s.d.token))).body.employees.find((x: any) => x.id === a.id)).toMatchObject({ open_orders: 1, delivered_today: 1 });
    await request(app).get('/api/v1/distributor/deliveries').set(auth(a.token)).expect(403);        // the board is for the owner
  });

  it('when someone is unavailable their work can be handed over, and nothing new is given to them', async () => {
    const s = await setup(); const away = await s.emp('Away'); const cover = await s.emp('Cover');
    const o1 = await accepted(s); const o2 = await accepted(s);
    for (const o of [o1, o2]) await request(app).post(`/api/v1/orders/${o}/assign`).set(auth(s.d.token)).send({ employee_id: away.id }).expect(200);

    await request(app).put(`/api/v1/distributor/employees/${away.id}`).set(auth(s.d.token)).send({ is_available: false }).expect(200);
    const o3 = await accepted(s);
    const blocked = await request(app).post(`/api/v1/orders/${o3}/assign`).set(auth(s.d.token)).send({ employee_id: away.id });
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('EMPLOYEE_UNAVAILABLE');
    expect((await request(app).post(`/api/v1/distributor/employees/${away.id}/reassign-all`).set(auth(s.d.token)).send({ to_employee_id: away.id })).status).toBe(409);

    const moved = await request(app).post(`/api/v1/distributor/employees/${away.id}/reassign-all`).set(auth(s.d.token)).send({ to_employee_id: cover.id }).expect(200);
    expect(moved.body.moved).toBe(2);
    expect((await request(app).get('/api/v1/orders').set(auth(cover.token))).body.orders.map((o: any) => o.id).sort()).toEqual([o1, o2].sort());
    expect((await request(app).get('/api/v1/orders').set(auth(away.token))).body.orders).toHaveLength(0);
    await move(away.token, o1, 'dispatched').expect(403);                      // no longer theirs

    // coming back: available again, assignable again; or the work can simply be un-assigned
    await request(app).put(`/api/v1/distributor/employees/${away.id}`).set(auth(s.d.token)).send({ is_available: true }).expect(200);
    await request(app).post(`/api/v1/orders/${o3}/assign`).set(auth(s.d.token)).send({ employee_id: away.id }).expect(200);
    expect((await request(app).post(`/api/v1/distributor/employees/${away.id}/reassign-all`).set(auth(s.d.token)).send({})).body.moved).toBe(1);
  });

  it('an employee can mark themselves away; a removed employee is signed out at once', async () => {
    const s = await setup(); const e = await s.emp('Self');
    await request(app).put('/api/v1/distributor/me/availability').set(auth(e.token)).send({ is_available: false }).expect(200);
    const oid = await accepted(s);
    expect((await request(app).post(`/api/v1/orders/${oid}/assign`).set(auth(s.d.token)).send({ employee_id: e.id })).status).toBe(409);
    await request(app).put('/api/v1/distributor/me/availability').set(auth(s.d.token)).send({ is_available: false }).expect(403);   // owners do not use this
    await request(app).put(`/api/v1/distributor/employees/${e.id}`).set(auth(s.d.token)).send({ is_active: false }).expect(200);
    await request(app).get('/api/v1/orders').set(auth(e.token)).expect(401);
    const other = await setup();
    await request(app).put(`/api/v1/distributor/employees/${e.id}`).set(auth(other.d.token)).send({ is_active: true }).expect(404);   // not their staff
  });
});

describe('outside-hierarchy orders for the distributor', () => {
  it('can be listed on their own', async () => {
    const s = await setup();
    // a second retailer who found this distributor by pincode while pinned elsewhere
    const home = await setup();
    const rp = phone();
    const out = (await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: rp, email: `o${rp}@t.local`, name: 'Out', password: 'password123', shop_name: 'Outsider', pincode: '400001' }).expect(201)).body;
    await request(app).post('/api/v1/distributor/retailers').set(auth(home.d.token)).send({ phone: rp }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${home.d.id}/accept`).set(auth(out.access_token)).expect(200);   // pinned: home
    const o = (await request(app).post('/api/v1/orders').set(auth(out.access_token)).set('Idempotency-Key', 'em-out').send({ distributor_id: s.d.id, items: [{ product_id: s.pid, qty: 1 }] }).expect(201)).body.order;
    expect(o.is_out_of_hierarchy).toBe(true);
    await accepted(s);                                                           // and one normal order
    const all = (await request(app).get('/api/v1/orders').set(auth(s.d.token))).body.orders;
    const only = (await request(app).get('/api/v1/orders').query({ outside: '1' }).set(auth(s.d.token))).body.orders;
    expect(all).toHaveLength(2);
    expect(only.map((x: any) => x.id)).toEqual([o.id]);
  });
});
