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
