import request from 'supertest';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7000000000 + 700000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (p: string, password = 'password123') => (await request(app).post('/api/v1/auth/login').send({ phone: p, password }).expect(200)).body.access_token as string;

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return login(p);
}

const staffBody = (over: object = {}) => ({ phone: phone(), name: 'Company Emp', password: 'password123', actions: ['create_distributors', 'manage_distributors'], grantable: ['chat_enabled', 'khatabook_enabled'], ...over });
const distBody = (over: object = {}) => ({ phone: phone(), name: 'Owner', password: 'password123', business_name: 'Biz ' + n, ...over });

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('1. admin creates company employees and decides what they may do', () => {
  it('creates an employee with chosen permissions, who can then sign in as company_employee', async () => {
    const a = await admin();
    const body = staffBody();
    const r = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(body).expect(201)).body;
    expect(r).toMatchObject({ name: 'Company Emp', is_active: true, actions: ['create_distributors', 'manage_distributors'], grantable: ['chat_enabled', 'khatabook_enabled'] });
    const login1 = (await request(app).post('/api/v1/auth/login').send({ phone: body.phone, password: 'password123' }).expect(200)).body;
    expect(login1.role).toBe('company_employee');
    const me = (await request(app).get('/api/v1/staff/me').set(auth(login1.access_token)).expect(200)).body;
    expect(me.actions).toEqual(['create_distributors', 'manage_distributors']);
    expect(me.grant_catalog.map((g: any) => g.key).sort()).toEqual(['chat_enabled', 'khatabook_enabled']);
  });

  it('only the admin can create or change company employees; unknown permission keys are dropped', async () => {
    const a = await admin();
    const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody({ actions: ['create_distributors', 'fly_to_moon'], grantable: ['chat_enabled', 'bogus'] })).expect(201)).body;
    expect(s.actions).toEqual(['create_distributors']);
    expect(s.grantable).toEqual(['chat_enabled']);
    const tok = await login(s.phone);
    expect((await request(app).post('/api/v1/admin/staff').set(auth(tok)).send(staffBody())).status).toBe(403);
    expect((await request(app).put(`/api/v1/admin/staff/${s.id}`).set(auth(tok)).send({ actions: ['view_commissions'] })).status).toBe(403);
  });

  it('a phone number can only be used once', async () => {
    const a = await admin(); const body = staffBody();
    await request(app).post('/api/v1/admin/staff').set(auth(a)).send(body).expect(201);
    expect((await request(app).post('/api/v1/admin/staff').set(auth(a)).send(body)).status).toBe(409);
  });

  it('switching a power off or suspending the person takes effect at once', async () => {
    const a = await admin();
    const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody()).expect(201)).body;
    const tok = await login(s.phone);
    await request(app).post('/api/v1/staff/distributors').set(auth(tok)).send(distBody()).expect(201);
    await request(app).put(`/api/v1/admin/staff/${s.id}`).set(auth(a)).send({ actions: [] }).expect(200);
    expect((await request(app).post('/api/v1/staff/distributors').set(auth(tok)).send(distBody())).status).toBe(403);
    await request(app).put(`/api/v1/admin/staff/${s.id}`).set(auth(a)).send({ is_active: false }).expect(200);
    expect((await request(app).get('/api/v1/staff/me').set(auth(tok))).status).toBe(401);
  });
});

describe('2. a company employee creates distributors, handing out only the switches the admin gave them', () => {
  it('creates a distributor who can sign in; ungranted switches start off', async () => {
    const a = await admin();
    const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody()).expect(201)).body;
    const tok = await login(s.phone);
    const body = distBody({ permissions: { chat_enabled: false } });
    const d = (await request(app).post('/api/v1/staff/distributors').set(auth(tok)).send(body).expect(201)).body;
    expect(d.permissions).toMatchObject({ chat_enabled: false, khatabook_enabled: true, self_delivery: false, employees_enabled: false, online_payments: false });
    const dTok = await login(body.phone);
    const prof = (await request(app).get('/api/v1/distributor/me').set(auth(dTok)).expect(200)).body;
    expect(prof.business_name).toBe(body.business_name);
    expect(prof.permissions.employees_enabled).toBe(false);
  });

  it('refuses a switch the employee does not hold', async () => {
    const a = await admin();
    const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody()).expect(201)).body;
    const tok = await login(s.phone);
    const r = await request(app).post('/api/v1/staff/distributors').set(auth(tok)).send(distBody({ permissions: { online_payments: true } }));
    expect(r.status).toBe(403);
    expect((await request(app).post('/api/v1/staff/distributors').set(auth(tok)).send(distBody({ permissions: { nonsense: true } }))).status).toBe(400);
  });

  it('needs the create_distributors power', async () => {
    const a = await admin();
    const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody({ actions: ['view_commissions'] })).expect(201)).body;
    const tok = await login(s.phone);
    expect((await request(app).post('/api/v1/staff/distributors').set(auth(tok)).send(distBody())).status).toBe(403);
    await request(app).get('/api/v1/staff/commissions').set(auth(tok)).expect(200);
  });

  it('updates only distributors they created, and only within what they may grant', async () => {
    const a = await admin();
    const s1 = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody()).expect(201)).body;
    const s2 = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody()).expect(201)).body;
    const t1 = await login(s1.phone); const t2 = await login(s2.phone);
    const d = (await request(app).post('/api/v1/staff/distributors').set(auth(t1)).send(distBody()).expect(201)).body;

    const upd = (await request(app).put(`/api/v1/staff/distributors/${d.id}`).set(auth(t1)).send({ permissions: { chat_enabled: false }, extend_days: 10 }).expect(200)).body;
    expect(upd.permissions.chat_enabled).toBe(false);
    expect((await request(app).put(`/api/v1/staff/distributors/${d.id}`).set(auth(t1)).send({ permissions: { online_payments: true } })).status).toBe(403);
    expect((await request(app).put(`/api/v1/staff/distributors/${d.id}`).set(auth(t2)).send({ permissions: { chat_enabled: true } })).status).toBe(404);   // not theirs

    const mine = (await request(app).get('/api/v1/staff/distributors').set(auth(t1)).expect(200)).body.distributors;
    expect(mine.map((x: any) => x.id)).toEqual([d.id]);
    expect((await request(app).get('/api/v1/staff/distributors').set(auth(t2)).expect(200)).body.distributors).toEqual([]);

    await request(app).put(`/api/v1/staff/distributors/${d.id}`).set(auth(t1)).send({ is_active: false }).expect(200);
    expect((await request(app).post('/api/v1/auth/login').send({ phone: d.phone, password: 'password123' })).status).toBe(401);
  });

  it('a company employee cannot reach admin, distributor or retailer areas', async () => {
    const a = await admin();
    const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(staffBody()).expect(201)).body;
    const tok = await login(s.phone);
    for (const url of ['/api/v1/admin/distributors', '/api/v1/distributor/employees', '/api/v1/retailer/stores']) expect((await request(app).get(url).set(auth(tok))).status).toBe(403);
  });
});

describe('3. a distributor creates employees and retailers, and may place a retailer under an employee', () => {
  async function distributor() {
    const a = await admin();
    const d = (await request(app).post('/api/v1/admin/distributors').set(auth(a)).send(distBody()).expect(201)).body;
    return { token: await login(d.phone), id: d.id as number };
  }
  const retailerBody = (over: object = {}) => ({ phone: phone(), name: 'Shop Keeper', password: 'password123', shop_name: 'Shop ' + n, pincode: '400001', address: '1 Main Road', ...over });

  it('creates a retailer who can sign in and is linked as a supplier at once', async () => {
    const d = await distributor();
    const body = retailerBody();
    const r = (await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(body).expect(201)).body;
    expect(r).toMatchObject({ shop_name: body.shop_name, managed_by_id: null });

    const list = (await request(app).get('/api/v1/distributor/retailers').set(auth(d.token)).expect(200)).body.retailers;
    expect(list.map((x: any) => x.id)).toContain(r.id);
    const rTok = await login(body.phone);
    const stores = (await request(app).get('/api/v1/retailer/stores').set(auth(rTok)).expect(200)).body;
    expect(JSON.stringify(stores)).toContain(String(d.id));
  });

  it('places a retailer under one of the distributor\'s own employees, and nobody else\'s', async () => {
    const d = await distributor(); const other = await distributor();
    const ep = phone();
    const e = (await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: ep, name: 'Field Rep', password: 'password123' }).expect(201)).body;
    const oe = (await request(app).post('/api/v1/distributor/employees').set(auth(other.token)).send({ phone: phone(), name: 'Other Rep', password: 'password123' }).expect(201)).body;

    const r = (await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(retailerBody({ managed_by_id: e.id })).expect(201)).body;
    expect(r.managed_by_id).toBe(e.id);
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(retailerBody({ managed_by_id: oe.id }))).status).toBe(400);

    const team = (await request(app).get('/api/v1/distributor/employees').set(auth(d.token)).expect(200)).body.employees;
    expect(team.find((x: any) => x.id === e.id).retailers).toBe(1);
  });

  it('refuses a phone that is already registered', async () => {
    const d = await distributor(); const body = retailerBody();
    await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(body).expect(201);
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(body)).status).toBe(409);
  });

  it('a retailer or a company employee cannot create retailer accounts', async () => {
    const d = await distributor();
    const body = retailerBody();
    await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(body).expect(201);
    const rTok = await login(body.phone);
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(rTok)).send(retailerBody())).status).toBe(403);
  });
});

describe('4. a distributor employee creates retailers under their own tree', () => {
  it('creates a retailer that sits under that employee, and the "mine" list shows only theirs', async () => {
    const a = await admin();
    const d = (await request(app).post('/api/v1/admin/distributors').set(auth(a)).send(distBody()).expect(201)).body;
    const dTok = await login(d.phone);
    const ep1 = phone(); const ep2 = phone();
    const e1 = (await request(app).post('/api/v1/distributor/employees').set(auth(dTok)).send({ phone: ep1, name: 'Rep One', password: 'password123' }).expect(201)).body;
    await request(app).post('/api/v1/distributor/employees').set(auth(dTok)).send({ phone: ep2, name: 'Rep Two', password: 'password123' }).expect(201);
    const t1 = await login(ep1); const t2 = await login(ep2);

    const body = { phone: phone(), name: 'Kirana Owner', password: 'password123', shop_name: 'Kirana', pincode: '400002' };
    const r = (await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(t1)).send({ ...body, managed_by_id: 999999 }).expect(201)).body;
    expect(r.managed_by_id).toBe(e1.id);   // the employee cannot choose someone else; it is always their own tree

    const mine1 = (await request(app).get('/api/v1/distributor/retailers?mine=1').set(auth(t1)).expect(200)).body.retailers;
    const mine2 = (await request(app).get('/api/v1/distributor/retailers?mine=1').set(auth(t2)).expect(200)).body.retailers;
    expect(mine1.map((x: any) => x.id)).toEqual([r.id]);
    expect(mine2).toEqual([]);

    const rTok = await login(body.phone);
    expect((await request(app).get('/api/v1/retailer/stores').set(auth(rTok))).status).toBe(200);
  });

  it('an expired subscription stops employees from creating retailers', async () => {
    const a = await admin();
    const d = (await request(app).post('/api/v1/admin/distributors').set(auth(a)).send(distBody()).expect(201)).body;
    const dTok = await login(d.phone);
    const ep = phone();
    await request(app).post('/api/v1/distributor/employees').set(auth(dTok)).send({ phone: ep, name: 'Rep', password: 'password123' }).expect(201);
    await exec(pool, 'UPDATE distributor_profiles SET subscription_ends_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE user_id = ?', [d.id]);
    const t = await login(ep);
    const r = await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(t)).send({ phone: phone(), name: 'Late Shop', password: 'password123', shop_name: 'Late', pincode: '400003' });
    expect(r.status).toBe(402);
  });
});
