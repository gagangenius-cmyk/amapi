import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7200000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function dist(name = 'Dist', pins: string[] = ['400001']) {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: name + ' ' + p }).expect(201);
  if (pins.length) await request(app).put('/api/v1/distributor/pincodes').set(auth(r.body.access_token)).send({ pincodes: pins }).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(r.body.access_token)).send({ name: 'Rice', price: '100', stock_qty: 100 })).body.id as number;
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p, pid };
}
async function ret(pincode = '400001') {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `r${p}@t.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode }).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
const invite = async (d: { token: string; id: number }, r: { token: string; phone: string }, accept = true) => {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  if (accept) await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
};
let k = 0;
const order = (r: { token: string }, d: { id: number; pid: number }, qty = 1) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'nw-' + ++k).send({ distributor_id: d.id, items: [{ product_id: d.pid, qty }] });
const perm = (adminToken: string, d: { id: number }, permissions: Record<string, boolean>) =>
  request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(adminToken)).send({ permissions }).expect(200);

let admin = '';
beforeAll(async () => {
  await migrate(true);
  const bcrypt = await import('bcryptjs');
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Root', await bcrypt.hash('password123', 4)]);
  admin = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' })).body.access_token;
});
afterAll(async () => { await pool.end(); });

describe('who can see a distributor\'s products', () => {
  it('nobody who is neither connected nor in a pincode it sells to', async () => {
    const d = await dist('Far', ['560001']);
    const stranger = await ret('400001');
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(stranger.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await order(stranger, d)).status).toBe(403);
    expect((await request(app).put('/api/v1/retailer/primary').set(auth(stranger.token)).send({ distributor_id: d.id })).status).toBe(404);
    const home = (await request(app).get('/api/v1/retailer/stores').set(auth(stranger.token))).body;
    expect([...home.nearby_distributors, ...home.linked_distributors].map((x: any) => x.id)).not.toContain(d.id);
  });

  it('retailers in a pincode it sells to, and retailers it is connected to', async () => {
    const d = await dist('Local', ['400001', '400002']);
    const near = await ret('400002'); const linked = await ret('110001');
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(near.token)).expect(200)).body.products).toHaveLength(1);
    await invite(d, linked);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(linked.token)).expect(200)).body.products).toHaveLength(1);   // far pincode, but connected
    const nearHome = (await request(app).get('/api/v1/retailer/stores').set(auth(near.token))).body;
    expect(nearHome.nearby_distributors.map((x: any) => x.id)).toContain(d.id);
  });

  it('the store profile shows an address and GSTIN only to connected retailers', async () => {
    const d = await dist('Profile');
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ address: '1 Station Road', city: 'Pune', pincode: '411001', gst_no: '27ABCDE1234F1Z5' }).expect(200);
    const near = await ret(); const linked = await ret(); await invite(d, linked);
    const a = (await request(app).get(`/api/v1/retailer/stores/${d.id}`).set(auth(near.token)).expect(200)).body;
    expect(a).toMatchObject({ city: 'Pune', access: 'pincode', address: null, gst_no: null, product_count: 1 });
    const b = (await request(app).get(`/api/v1/retailer/stores/${d.id}`).set(auth(linked.token)).expect(200)).body;
    expect(b).toMatchObject({ access: 'linked', address: '1 Station Road', gst_no: '27ABCDE1234F1Z5', is_pinned: true, in_hierarchy: true });
  });

  it('"sell by pincode" off hides the store from unconnected retailers but not from connected ones', async () => {
    const d = await dist('Private');
    const near = await ret(); const linked = await ret(); await invite(d, linked);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(near.token))).status).toBe(200);
    await perm(admin, d, { pincode_selling: false });
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(near.token))).status).toBe(404);
    expect((await order(near, d)).status).toBe(403);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(linked.token))).status).toBe(200);
    expect((await order(linked, d)).status).toBe(201);
    const home = (await request(app).get('/api/v1/retailer/stores').set(auth(near.token))).body;
    expect(home.nearby_distributors.map((x: any) => x.id)).not.toContain(d.id);
  });

  it('an invited retailer can look before answering; an expired distributor disappears', async () => {
    const d = await dist('Inviter');
    const r = await ret('999999'); await invite(d, r, false);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(r.token))).status).toBe(200);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    await exec(pool, 'UPDATE distributor_profiles SET subscription_ends_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE user_id = ?', [d.id]);
    expect((await request(app).get(`/api/v1/retailer/stores/${d.id}/products`).set(auth(r.token))).status).toBe(404);
  });
});

describe('the retailer home', () => {
  it('puts the pinned distributor first with a preview of up to 20 products, then the others', async () => {
    const first = await dist('First'); const second = await dist('Second'); const third = await dist('Third', ['400001']);
    for (let i = 0; i < 24; i++) await request(app).post('/api/v1/catalog').set(auth(first.token)).send({ name: 'Item ' + i, price: '10', stock_qty: 5 }).expect(201);
    const r = await ret();
    await invite(first, r); await invite(second, r);
    const home = (await request(app).get('/api/v1/retailer/stores').set(auth(r.token)).expect(200)).body;
    expect(home.primary_distributor).toMatchObject({ id: first.id, is_pinned: true, product_count: 25 });
    expect(home.primary_distributor.products).toHaveLength(20);
    expect(home.linked_distributors.map((x: any) => x.id)).toEqual([second.id]);
    expect(home.nearby_distributors.map((x: any) => x.id)).toContain(third.id);
    expect(home.nearby_distributors.map((x: any) => x.id)).not.toContain(second.id);   // already connected
    // the full store is one tap away and has everything
    expect((await request(app).get(`/api/v1/retailer/stores/${first.id}/products`).set(auth(r.token))).body.products).toHaveLength(25);
  });
});

describe('orders outside the hierarchy (commission)', () => {
  it('only a distributor who is neither pinned nor brought the retailer in is "outside"', async () => {
    const mine = await dist('Mine'); const alsoMine = await dist('AlsoMine'); const stranger = await dist('Stranger');
    const r = await ret();
    await invite(mine, r); await invite(alsoMine, r);                   // both brought the retailer in
    expect((await order(r, mine)).body.order.is_out_of_hierarchy).toBe(false);
    expect((await order(r, alsoMine)).body.order.is_out_of_hierarchy).toBe(false);   // not pinned, but THEIR retailer
    const o = (await order(r, stranger)).body.order;                    // found by pincode: outside
    expect(o).toMatchObject({ is_out_of_hierarchy: true, commission_rate_bps: 200 });
    // and it is listed on its own for the platform
    const rows = (await request(app).get('/api/v1/admin/commissions').set(auth(admin))).body.commissions;
    expect(rows.every((x: any) => x.distributor_id !== mine.id)).toBe(true);
  });
});

describe('permissions', () => {
  it('online payments off blocks UPI details, UTR reports and card links', async () => {
    const d = await dist('NoOnline'); const r = await ret(); await invite(d, r);
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { upi_id: 'shop@okhdfc' } }).expect(200);
    await request(app).get(`/api/v1/payments/pay-info/${d.id}`).set(auth(r.token)).expect(200);
    await perm(admin, d, { online_payments: false });
    expect((await request(app).get(`/api/v1/payments/pay-info/${d.id}`).set(auth(r.token))).status).toBe(403);
    expect((await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'np1').send({ distributor_id: d.id, amount: '10', utr: 'UTRPERM0001' })).status).toBe(403);
    await perm(admin, d, { online_payments: true });
    await request(app).get(`/api/v1/payments/pay-info/${d.id}`).set(auth(r.token)).expect(200);
  });

  it('team members off blocks adding employees; delivery off blocks assigning', async () => {
    const d = await dist('Solo'); const r = await ret(); await invite(d, r);
    const add = (phoneNo: string) => request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: phoneNo, name: 'Emp One', password: 'password123' });
    expect((await add(phone())).status).toBe(201);
    await perm(admin, d, { employees_enabled: false });
    expect((await add(phone())).status).toBe(403);
    await perm(admin, d, { employees_enabled: true, self_delivery: false });
    const oid = (await order(r, d)).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    const emp = (await q1<any>(pool, "SELECT id FROM users WHERE owner_distributor_id = ? LIMIT 1", [d.id]))!;
    expect((await request(app).post(`/api/v1/orders/${oid}/assign`).set(auth(d.token)).send({ employee_id: emp.id })).status).toBe(403);
  });

  it('the admin can read the full list of switches', async () => {
    const list = (await request(app).get('/api/v1/admin/distributors').set(auth(admin)).expect(200)).body;
    expect(list.permission_catalog.map((p: any) => p.key)).toEqual(expect.arrayContaining(['self_delivery', 'khatabook_enabled', 'chat_enabled', 'notifications_enabled', 'pincode_selling', 'online_payments', 'employees_enabled']));
    expect(Object.keys(list.distributors[0].permissions)).toEqual(expect.arrayContaining(['pincode_selling', 'notifications_enabled']));
  });
});
