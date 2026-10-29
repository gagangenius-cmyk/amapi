import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7000000000 + 900000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function world() {
  const dp = phone();
  const d = (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: dp, email: `d${dp}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + dp }).expect(201)).body;
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.access_token)).send({ name: 'Rice', price: '100', stock_qty: 50 }).expect(201)).body.id as number;
  const ep = phone();
  await request(app).post('/api/v1/distributor/employees').set(auth(d.access_token)).send({ phone: ep, name: 'Emp', password: 'password123' }).expect(201);
  const emp = (await request(app).post('/api/v1/auth/login').send({ phone: ep, password: 'password123' }).expect(200)).body;
  const mk = async (token: string, pincode: string) => {
    const p = phone();
    return (await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(token)).send({ phone: p, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode }).expect(201)).body.id as number;
  };
  return { d: d.access_token as string, emp: emp.access_token as string, pid, mk };
}

const put = (token: string, pid: number, body: object) => request(app).put(`/api/v1/catalog/${pid}/audience`).set(auth(token)).send(body);
const audience = async (token: string, pid: number) => ((await request(app).get(`/api/v1/catalog/${pid}/audience`).set(auth(token)).expect(200)).body.retailers as { id: number }[]).map((r) => r.id).sort();

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('product audience', () => {
  it('an employee can limit a product to the retailers they created ("mine")', async () => {
    const w = await world();
    const mine1 = await w.mk(w.emp, '400001');
    const mine2 = await w.mk(w.emp, '400002');
    const others = await w.mk(w.d, '400001'); // created by the distributor, not by the employee
    const res = await put(w.emp, w.pid, { mine: true }).expect(200);
    expect(res.body).toMatchObject({ private: true, retailers: 2 });
    expect(await audience(w.d, w.pid)).toEqual([mine1, mine2].sort());
    expect(await audience(w.d, w.pid)).not.toContain(others);
  });

  it('an employee can limit a product to chosen pincodes, but only among their own retailers', async () => {
    const w = await world();
    const a = await w.mk(w.emp, '400001');
    await w.mk(w.emp, '400002');
    const foreign = await w.mk(w.d, '400001');
    await put(w.emp, w.pid, { pincodes: ['400001'] }).expect(200);
    const got = await audience(w.d, w.pid);
    expect(got).toEqual([a]);
    expect(got).not.toContain(foreign);
  });

  it('an employee cannot name a retailer they do not manage', async () => {
    const w = await world();
    const foreign = await w.mk(w.d, '400001');
    const r = await put(w.emp, w.pid, { retailer_ids: [foreign] }).expect(400);
    expect(r.body.error.code).toBe('NOT_YOUR_RETAILER');
  });

  it('an employee cannot override a limit the distributor set for other retailers', async () => {
    const w = await world();
    const foreign = await w.mk(w.d, '400001');
    await w.mk(w.emp, '400001');
    await put(w.d, w.pid, { retailer_ids: [foreign] }).expect(200);
    await put(w.emp, w.pid, { mine: true }).expect(403);
    expect(await audience(w.d, w.pid)).toEqual([foreign]);
  });

  it('the distributor can use pincodes, and an empty result opens the product to everyone', async () => {
    const w = await world();
    const a = await w.mk(w.d, '400001');
    await w.mk(w.d, '400009');
    await put(w.d, w.pid, { pincodes: ['400001'] }).expect(200);
    expect(await audience(w.d, w.pid)).toEqual([a]);
    const open = await put(w.d, w.pid, { retailer_ids: [] }).expect(200);
    expect(open.body.private).toBe(false);
    expect(await audience(w.d, w.pid)).toEqual([]);
  });

  it('requires saying who can see the product, and "mine" is employee-only', async () => {
    const w = await world();
    await put(w.d, w.pid, {}).expect(400);
    await put(w.d, w.pid, { mine: true }).expect(400);
  });
});
