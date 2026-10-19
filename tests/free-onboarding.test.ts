import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const phone = () => String(8300000000 + ++n);

// the testing-period switch is read on every request, so this file turns it on and puts it back (the other suites test the paid path)
beforeAll(async () => { process.env.FREE_ONBOARDING = '1'; await migrate(true); });
afterAll(async () => { process.env.FREE_ONBOARDING = '0'; await pool.end(); });

describe('free onboarding (testing period)', () => {
  it('creates a live distributor at once for ₹0, with no payment step', async () => {
    const ap = phone();
    await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [ap, 'Admin', await bcrypt.hash('password123', 4)]);
    const admin = (await request(app).post('/api/v1/auth/login').send({ phone: ap, password: 'password123' }).expect(200)).body.access_token as string;
    const sp = phone();
    await request(app).post('/api/v1/admin/staff').set(auth(admin)).send({ phone: sp, name: 'Emp', password: 'password123', email: `e${sp}@test.local`, actions: ['create_distributors'], grantable: [] }).expect(201);
    const emp = (await request(app).post('/api/v1/auth/login').send({ phone: sp, password: 'password123' }).expect(200)).body.access_token as string;
    const cat = (await request(app).post('/api/v1/admin/categories').set(auth(admin)).send({ name: 'Cat ' + sp }).expect(201)).body.id;

    const meta = (await request(app).get('/api/v1/staff/onboarding/meta').set(auth(emp)).expect(200)).body;
    expect(meta.free_mode).toBe(true);
    expect(meta.plans.every((p: any) => p.price === '0.00')).toBe(true);

    const dp = phone();
    const res = await request(app).post('/api/v1/staff/onboarding').set(auth(emp)).set('Idempotency-Key', 'free-' + dp).send({
      business_name: 'Free Biz', name: 'Owner', phone: dp, password: 'password123', plan_id: meta.plans[0].id, method: 'upi', category_ids: [cat],
    });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ status: 'completed', amount: '0.00' });
    await request(app).post('/api/v1/auth/login').send({ phone: dp, password: 'password123' }).expect(200);
    const row = await q1<any>(pool, 'SELECT subscription_ends_at FROM distributor_profiles dp JOIN users u ON u.id = dp.user_id WHERE u.phone = ?', [dp]);
    expect(new Date(row.subscription_ends_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('₹0 plans', () => {
  it('the onboarding options include a ₹0 plan, and it never shows in the distributor renewal list', async () => {
    const ap = String(8400000000 + Math.floor(Math.random() * 99999));
    await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [ap, 'Admin', await bcrypt.hash('password123', 4)]);
    const admin = (await request(app).post('/api/v1/auth/login').send({ phone: ap, password: 'password123' }).expect(200)).body.access_token as string;
    const sp = String(8500000000 + Math.floor(Math.random() * 99999));
    await request(app).post('/api/v1/admin/staff').set(auth(admin)).send({ phone: sp, name: 'Emp', password: 'password123', email: `e${sp}@test.local`, actions: ['create_distributors'], grantable: [] }).expect(201);
    const emp = (await request(app).post('/api/v1/auth/login').send({ phone: sp, password: 'password123' }).expect(200)).body.access_token as string;
    const meta = (await request(app).get('/api/v1/staff/onboarding/meta').set(auth(emp)).expect(200)).body;
    expect(meta.plans.some((p: any) => p.price === '0.00')).toBe(true);
    expect(meta.free_plan_ids.length).toBeGreaterThan(0);
    // an admin can also add a ₹0 plan by hand
    await request(app).post('/api/v1/admin/plans').set(auth(admin)).send({ name: 'Zero test', days: 10, price: '0' }).expect(201);
  });
});

describe('subscriptions in the testing period', () => {
  it('an expired distributor is treated as active and is not blocked; it blocks again once the switch is off', async () => {
    const p = String(8600000000 + Math.floor(Math.random() * 99999));
    const reg = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Expired Biz ' + p }).expect(201);
    const t = reg.body.access_token as string;
    await exec(pool, 'UPDATE distributor_profiles SET subscription_ends_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY) WHERE user_id = ?', [reg.body.id]);

    const sub = (await request(app).get('/api/v1/subscription').set(auth(t)).expect(200)).body;
    expect(sub).toMatchObject({ status: 'active', free_mode: true, plan_name: 'Free (testing)', plans: [] });
    await request(app).post('/api/v1/catalog').set(auth(t)).send({ name: 'Test item', price: '10', stock_qty: 5 }).expect(201);

    process.env.FREE_ONBOARDING = '0';
    expect((await request(app).get('/api/v1/subscription').set(auth(t)).expect(200)).body.status).toBe('expired');
    await request(app).post('/api/v1/catalog').set(auth(t)).send({ name: 'Blocked item', price: '10', stock_qty: 5 }).expect(402);
    process.env.FREE_ONBOARDING = '1';
  });
});
