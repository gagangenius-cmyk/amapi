import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(8100000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return { id: (await q1<any>(pool, 'SELECT id FROM users WHERE phone = ?', [p]))!.id as number, token: (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string };
}
const reg = async (role: 'distributor' | 'retailer') => {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
};

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('admin edits profiles of the roles below it', () => {
  it('edits a retailer (shop, address, pincode, phone, email)', async () => {
    const a = await admin(); const r = await reg('retailer');
    const np = phone();
    const res = await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token))
      .send({ name: 'New Name', phone: np, email: `new${np}@test.local`, shop_name: 'Fresh Shop', address: '12 Market Road', pincode: '110001', gst_no: '27ABCDE1234F1Z5' }).expect(200);
    expect(res.body).toMatchObject({ role: 'retailer', name: 'New Name', phone: np, shop_name: 'Fresh Shop', address: '12 Market Road', pincode: '110001', gst_no: '27ABCDE1234F1Z5' });
    const got = await request(app).get(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token)).expect(200);
    expect(got.body.shop_name).toBe('Fresh Shop');
    expect((await q1<any>(pool, "SELECT action FROM audit_log WHERE action = 'admin.user_profile_edit' AND entity_id = ? ORDER BY id DESC LIMIT 1", [r.id]))).toBeTruthy();
  });

  it('edits a distributor (business, GST, address, city)', async () => {
    const a = await admin(); const d = await reg('distributor');
    const res = await request(app).put(`/api/v1/admin/users/${d.id}/profile`).set(auth(a.token))
      .send({ business_name: 'Mega Traders', city: 'Pune', address: 'Plot 5, MIDC', pincode: '411001' }).expect(200);
    expect(res.body).toMatchObject({ role: 'distributor', business_name: 'Mega Traders', city: 'Pune', address: 'Plot 5, MIDC', pincode: '411001' });
  });

  it('edits a distributor employee and a company employee (name, phone)', async () => {
    const a = await admin(); const d = await reg('distributor');
    const ep = phone();
    await exec(pool, "INSERT INTO users (role, phone, name, password_hash, owner_distributor_id) VALUES ('employee',?,?,?,?)", [ep, 'Helper', await bcrypt.hash('password123', 4), d.id]);
    const eid = (await q1<any>(pool, 'SELECT id FROM users WHERE phone = ?', [ep]))!.id;
    const r1 = await request(app).put(`/api/v1/admin/users/${eid}/profile`).set(auth(a.token)).send({ name: 'Helper Two' }).expect(200);
    expect(r1.body).toMatchObject({ role: 'employee', name: 'Helper Two', works_for: 'Owner' });
    const staff = (await request(app).post('/api/v1/admin/staff').set(auth(a.token)).send({ phone: phone(), name: 'Emp', password: 'password123' }).expect(201)).body;
    const r2 = await request(app).put(`/api/v1/admin/users/${staff.id}/profile`).set(auth(a.token)).send({ name: 'Emp Renamed' }).expect(200);
    expect(r2.body).toMatchObject({ role: 'company_employee', name: 'Emp Renamed' });
  });

  it('refuses: other admins, a taken phone, role-specific fields on the wrong role, empty edits', async () => {
    const a = await admin(); const b = await admin(); const r = await reg('retailer'); const r2 = await reg('retailer');
    await request(app).put(`/api/v1/admin/users/${b.id}/profile`).set(auth(a.token)).send({ name: 'Hacked' }).expect(404);
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token)).send({ phone: r2.phone }).expect(409);
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token)).send({ business_name: 'Nope' }).expect(400);
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token)).send({}).expect(400);
  });

  it('sets a new password (old one stops working, sessions end); the hash is never returned', async () => {
    const a = await admin(); const r = await reg('retailer');
    const res = await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token)).send({ password: 'BrandNew#123' }).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'password123' }).expect(401);
    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'BrandNew#123' }).expect(200);
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(a.token)).send({ password: 'short' }).expect(400);
  });

  it('is for the admin only', async () => {
    const a = await admin(); const r = await reg('retailer'); const d = await reg('distributor');
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(d.token)).send({ name: 'Nope' }).expect(403);
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).set(auth(r.token)).send({ name: 'Nope' }).expect(403);
    await request(app).put(`/api/v1/admin/users/${r.id}/profile`).send({ name: 'Nope' }).expect(401);
    void a;
  });
});
