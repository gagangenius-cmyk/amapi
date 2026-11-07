import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool } from '../src/db/pool';
import { splitAmounts } from '../src/modules/orders/milestones.routes';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let n = 0; let k = 0;
const phone = () => String(7300000000 + ++n * 7 + Math.floor(Math.random() * 5));

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Dist ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret ' + p, password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, email, password_hash) VALUES ('admin',?,?,?,?)", [p, 'Root', `a${p}@test.local`, await bcrypt.hash('password123', 4)]);
  return { token: (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string };
}
async function shopWithOrder() {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', stock_qty: 50 })).body.id as number;
  const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'ms-' + ++k).send({ distributor_id: d.id, items: [{ product_id: pid, qty: 3 }] }).expect(201)).body.order.id as number;
  return { d, r, oid };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('splitAmounts', () => {
  it('always adds up to the total, rounding into the last part', () => {
    expect(splitAmounts(10000, [3000, 7000])).toEqual([3000, 7000]);
    const parts = splitAmounts(10001, [3333, 3333, 3334]);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(10001);
  });
});

describe('payment milestones', () => {
  it('distributor sets a 30/70 schedule, marks parts paid, and the retailer sees it; strangers cannot', async () => {
    const { d, r, oid } = await shopWithOrder(); const stranger = await reg('retailer');
    const url = `/api/v1/orders/${oid}/milestones`;

    expect((await request(app).get(url).set(auth(r.token)).expect(200)).body.milestones).toEqual([]);
    await request(app).put(url).set(auth(r.token)).send({ milestones: [{ label: 'All', percent: 100 }] }).expect(403);   // retailers cannot set terms
    await request(app).get(url).set(auth(stranger.token)).expect(404);                                                   // other people's orders do not exist

    await request(app).put(url).set(auth(d.token)).send({ milestones: [{ label: 'Advance', percent: 30 }, { label: 'Rest', percent: 60, due_event: 'delivered' }] }).expect(400); // not 100
    const set = (await request(app).put(url).set(auth(d.token)).send({ milestones: [{ label: 'Advance', percent: 30, due_event: 'order' }, { label: 'On delivery', percent: 70, due_event: 'delivered' }] }).expect(200)).body;
    expect(set.milestones.map((m: any) => m.status)).toEqual(['due', 'upcoming']);   // advance is due now; delivery has not happened
    expect(Number(set.milestones[0].amount) + Number(set.milestones[1].amount)).toBeCloseTo(Number(set.total), 2);

    const seen = (await request(app).get(url).set(auth(r.token)).expect(200)).body;
    expect(seen.milestones).toHaveLength(2);
    await request(app).post(`${url}/1/paid`).set(auth(r.token)).send({}).expect(403);

    const paid = (await request(app).post(`${url}/1/paid`).set(auth(d.token)).send({ method: 'upi', reference: 'UTR123' }).expect(200)).body;
    expect(paid.milestones[0]).toMatchObject({ status: 'paid', method: 'upi', reference: 'UTR123' });
    expect(Number(paid.paid)).toBeCloseTo(Number(set.milestones[0].amount), 2);
    expect(Number(paid.remaining)).toBeCloseTo(Number(set.milestones[1].amount), 2);
    await request(app).post(`${url}/1/paid`).set(auth(d.token)).send({}).expect(200);                                   // repeating is harmless

    const locked = await request(app).put(url).set(auth(d.token)).send({ milestones: [{ label: 'All', percent: 100 }] }).expect(409);
    expect(locked.body.error.code).toBe('MILESTONE_PAID');                                                                // paid history cannot be rewritten

    const undone = (await request(app).delete(`${url}/1/paid`).set(auth(d.token)).expect(200)).body;
    expect(undone.milestones[0].status).toBe('due');
    await request(app).post(`${url}/9/paid`).set(auth(d.token)).send({}).expect(404);
  });
});

describe('QR scan history', () => {
  it('admin sees visits across the platform with filters; employees see only their own', async () => {
    const a = await admin();
    const d = await reg('distributor'); const r = await reg('retailer');
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    const ep = phone();
    const e = (await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: ep, name: 'Field Emp', password: 'password123' }).expect(201)).body;
    const et = (await request(app).post('/api/v1/auth/login').send({ phone: ep, password: 'password123' }).expect(200)).body.access_token as string;
    await request(app).put('/api/v1/field/shop-location').set(auth(r.token)).send({ lat: 19.076, lng: 72.8777 }).expect(200);
    const code = (await request(app).get('/api/v1/field/visit-code').set(auth(r.token)).expect(200)).body.code as string;
    await request(app).post('/api/v1/field/punch').set(auth(et)).send({ code, lat: 19.0761, lng: 72.8778 }).expect(201);

    const all = (await request(app).get('/api/v1/admin/visits').query({ employee_id: e.id }).set(auth(a.token)).expect(200)).body;
    expect(all.visits).toHaveLength(1);
    expect(all.visits[0]).toMatchObject({ employee_name: 'Field Emp', near: true });
    expect(all.visits[0].distributor_name).toContain('Dist');
    expect(all.visits[0].lat).toBeCloseTo(19.0761, 3);
    expect((await request(app).get('/api/v1/admin/visits').query({ q: 'no-such-shop-zzz' }).set(auth(a.token)).expect(200)).body.visits).toHaveLength(0);
    await request(app).get('/api/v1/admin/visits').set(auth(d.token)).expect(403);

    const mine = (await request(app).get('/api/v1/field/my-visits').set(auth(et)).expect(200)).body.visits;
    expect(mine).toHaveLength(1);
    expect(mine[0].shop_name).toContain('Shop');
    await request(app).get('/api/v1/field/my-visits').set(auth(d.token)).expect(403);
  });
});
