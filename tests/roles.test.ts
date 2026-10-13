import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { exec, pool } from '../src/db/pool';
import * as totp from '../src/utils/totp';
import { startOnboarding } from './helpers/onboard';

const app = createApp();
let n = 0;
const phone = () => String(7300000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const step = () => Math.floor(Date.now() / 30000);

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
}
const staff = async (a: string, over: object = {}) =>
  (await request(app).post('/api/v1/admin/staff').set(auth(a)).send({ phone: phone(), name: 'Emp', password: 'password123', ...over }).expect(201)).body;
const login = async (p: string) => (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
const newDistributor = async (t: string, a: string) => (await startOnboarding(app, { token: a }, { token: t })).res;

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('named roles', () => {
  it('ships built-in roles and lets the admin create custom ones', async () => {
    const a = await admin();
    const list = (await request(app).get('/api/v1/admin/roles').set(auth(a)).expect(200)).body;
    expect(list.roles.filter((r: any) => r.is_system).map((r: any) => r.name).sort()).toEqual(['Distributor Viewer', 'Onboarding Manager']);
    expect(list.action_catalog.length).toBeGreaterThan(0);

    const r = (await request(app).post('/api/v1/admin/roles').set(auth(a)).send({ name: 'Regional Onboarder', actions: ['create_distributors', 'nonsense'], grantable: ['chat_enabled'] }).expect(201)).body;
    expect(r).toMatchObject({ name: 'Regional Onboarder', is_system: false, actions: ['create_distributors'], grantable: ['chat_enabled'], members: 0 });
    expect((await request(app).post('/api/v1/admin/roles').set(auth(a)).send({ name: 'Regional Onboarder', actions: [], grantable: [] })).status).toBe(409);
  });

  it('only the admin manages roles', async () => {
    const a = await admin();
    const s = await staff(a, { actions: ['create_distributors'], grantable: [] });
    const t = await login(s.phone);
    expect((await request(app).get('/api/v1/admin/roles').set(auth(t))).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/roles').set(auth(t)).send({ name: 'Sneaky', actions: [], grantable: [] })).status).toBe(403);
  });

  it('a member gets the role\'s powers, and editing the role changes them at once', async () => {
    const a = await admin();
    const role = (await request(app).post('/api/v1/admin/roles').set(auth(a)).send({ name: 'Starter', actions: [], grantable: [] }).expect(201)).body;
    const s = await staff(a, { role_id: role.id });
    expect(s).toMatchObject({ role_id: role.id, role_name: 'Starter', actions: [] });
    const t = await login(s.phone);
    expect((await newDistributor(t, a)).status).toBe(403);

    await request(app).put(`/api/v1/admin/roles/${role.id}`).set(auth(a)).send({ actions: ['create_distributors'], grantable: ['chat_enabled'] }).expect(200);
    const me = (await request(app).get('/api/v1/staff/me').set(auth(t)).expect(200)).body;
    expect(me.actions).toEqual(['create_distributors']);
    expect((await newDistributor(t, a)).status).toBe(201);
    const roleNow = (await request(app).get('/api/v1/admin/roles').set(auth(a))).body.roles.find((r: any) => r.id === role.id);
    expect(roleNow.members).toBe(1);
  });

  it('editing a person\'s powers directly makes them custom and leaves the role alone', async () => {
    const a = await admin();
    const role = (await request(app).post('/api/v1/admin/roles').set(auth(a)).send({ name: 'Shared', actions: ['create_distributors'], grantable: ['chat_enabled'] }).expect(201)).body;
    const s1 = await staff(a, { role_id: role.id });
    const s2 = await staff(a, { role_id: role.id });
    const out = (await request(app).put(`/api/v1/admin/staff/${s1.id}`).set(auth(a)).send({ actions: [] }).expect(200)).body;
    expect(out).toMatchObject({ role_id: null, actions: [], grantable: ['chat_enabled'] });   // the other half of the role is kept
    const t2 = await login(s2.phone);
    expect((await request(app).get('/api/v1/staff/me').set(auth(t2))).body.actions).toEqual(['create_distributors']);
    await request(app).put(`/api/v1/admin/staff/${s1.id}`).set(auth(a)).send({ role_id: role.id }).expect(200);
    expect((await request(app).put(`/api/v1/admin/staff/${s1.id}`).set(auth(a)).send({ role_id: 99999 })).status).toBe(400);
  });

  it('built-in roles and roles in use cannot be changed or deleted', async () => {
    const a = await admin();
    const sys = (await request(app).get('/api/v1/admin/roles').set(auth(a))).body.roles.find((r: any) => r.is_system);
    expect((await request(app).put(`/api/v1/admin/roles/${sys.id}`).set(auth(a)).send({ actions: [] })).status).toBe(409);
    expect((await request(app).delete(`/api/v1/admin/roles/${sys.id}`).set(auth(a))).status).toBe(409);

    const role = (await request(app).post('/api/v1/admin/roles').set(auth(a)).send({ name: 'Temp', actions: [], grantable: [] }).expect(201)).body;
    const s = await staff(a, { role_id: role.id });
    expect((await request(app).delete(`/api/v1/admin/roles/${role.id}`).set(auth(a))).body.error.code).toBe('ROLE_IN_USE');
    await request(app).put(`/api/v1/admin/staff/${s.id}`).set(auth(a)).send({ role_id: null }).expect(200);
    await request(app).delete(`/api/v1/admin/roles/${role.id}`).set(auth(a)).expect(204);
  });
});

describe('two-factor for company employees', () => {
  it('can be switched on, and is required for the staff area when enforced', async () => {
    const a = await admin();
    const s = await staff(a, { actions: ['create_distributors'], grantable: [] });
    const t = await login(s.phone);

    (env as any).adminRequires2fa = true;
    try {
      const blocked = await request(app).get('/api/v1/staff/me').set(auth(t));
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('TWO_FACTOR_REQUIRED');

      const { body } = await request(app).post('/api/v1/auth/2fa/setup').set(auth(t)).expect(200);
      await request(app).post('/api/v1/auth/2fa/enable').set(auth(t)).send({ code: totp.codeAt(body.secret, step()) }).expect(200);
      await request(app).get('/api/v1/staff/me').set(auth(t)).expect(200);
      expect((await request(app).get('/api/v1/me').set(auth(t))).body.two_factor).toBe(true);
      // the next sign-in asks for a code
      const again = await request(app).post('/api/v1/auth/login').send({ phone: s.phone, password: 'password123' });
      expect(again.body.error.code).toBe('TOTP_REQUIRED');
    } finally { (env as any).adminRequires2fa = false; }
  });

  it('is not offered to distributors or retailers', async () => {
    const p = phone();
    const d = (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@t.local`, name: 'Dee', password: 'password123', business_name: 'Biz ' + p }).expect(201)).body;
    expect((await request(app).post('/api/v1/auth/2fa/setup').set(auth(d.access_token))).status).toBe(403);
  });
});

describe('login history', () => {
  it('records sign-ins and failed attempts for the account, newest first', async () => {
    const a = await admin();
    const s = await staff(a);
    await request(app).post('/api/v1/auth/login').send({ phone: s.phone, password: 'wrong-password' }).expect(401);
    const t = await login(s.phone);
    const h = (await request(app).get('/api/v1/me/login-history').set(auth(t)).expect(200)).body.entries;
    expect(h.map((e: any) => e.event)).toEqual(['auth.login', 'auth.login_failed']);
    expect(h[0].ok).toBe(true);
    expect(h[1].ok).toBe(false);

    // someone else's history is never visible
    const other = await staff(a);
    const ot = await login(other.phone);
    expect((await request(app).get('/api/v1/me/login-history').set(auth(ot))).body.entries.map((e: any) => e.event)).toEqual(['auth.login']);
  });
});
