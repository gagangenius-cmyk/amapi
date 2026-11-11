import request from 'supertest';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';
import { onboardDistributor } from './helpers/onboard';

const app = createApp();
let n = 0;
const phone = () => String(6100000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (p: string) => (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return login(p);
}
async function staff(a: string) {
  const body = { phone: phone(), name: 'Staff ' + n, password: 'password123', actions: ['create_distributors', 'manage_distributors'], grantable: ['employees_enabled'] };
  const s = (await request(app).post('/api/v1/admin/staff').set(auth(a)).send(body).expect(201)).body;
  return { id: s.id as number, token: await login(body.phone) };
}
async function distributor(a: string, emp: { token: string }) {
  const d = await onboardDistributor(app, { token: a }, emp, { permissions: { employees_enabled: true } });
  return { id: d.id as number, token: d.token as string, categoryId: d.category!.id as number };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('admin moves distributors to another company employee in bulk', () => {
  it('moves the chosen distributors, or everything one employee looks after', async () => {
    const a = await admin();
    const e1 = await staff(a); const e2 = await staff(a); const e3 = await staff(a);
    const d1 = await distributor(a, e1); const d2 = await distributor(a, e1); const d3 = await distributor(a, e1);

    const r1 = await request(app).put('/api/v1/admin/distributors/bulk-employee').set(auth(a)).send({ employee_id: e2.id, distributor_ids: [d1.id, d2.id] }).expect(200);
    expect(r1.body.moved).toBe(2);
    expect((await q1<any>(pool, 'SELECT created_by FROM users WHERE id = ?', [d1.id]))!.created_by).toBe(e2.id);
    expect((await q1<any>(pool, 'SELECT created_by FROM users WHERE id = ?', [d3.id]))!.created_by).toBe(e1.id);   // not chosen: stays

    const r2 = await request(app).put('/api/v1/admin/distributors/bulk-employee').set(auth(a)).send({ employee_id: e3.id, from_employee_id: e2.id }).expect(200);
    expect(r2.body.moved).toBe(2);
    expect((await q1<any>(pool, 'SELECT created_by FROM users WHERE id = ?', [d2.id]))!.created_by).toBe(e3.id);
  });

  it('refuses a missing selection, an unknown target, and anyone who is not the admin', async () => {
    const a = await admin(); const e1 = await staff(a);
    expect((await request(app).put('/api/v1/admin/distributors/bulk-employee').set(auth(a)).send({ employee_id: e1.id })).status).toBe(400);
    expect((await request(app).put('/api/v1/admin/distributors/bulk-employee').set(auth(a)).send({ employee_id: 999999, distributor_ids: [1] })).status).toBe(400);
    expect((await request(app).put('/api/v1/admin/distributors/bulk-employee').set(auth(e1.token)).send({ employee_id: e1.id, distributor_ids: [1] })).status).toBe(403);
  });
});

describe('a distributor moves retailers between team members in bulk', () => {
  const retailer = (d: { token: string; categoryId: number }, managed_by_id?: number) => request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token))
    .send({ phone: phone(), name: 'Keeper', password: 'password123', shop_name: 'Shop ' + n, pincode: '400001', category_ids: [d.categoryId], ...(managed_by_id ? { managed_by_id } : {}) }).expect(201).then((r) => r.body.id as number);
  const member = (d: { token: string }, kind: 'sales' | 'delivery') => request(app).post('/api/v1/distributor/employees').set(auth(d.token))
    .send({ phone: phone(), name: 'Member ' + n, password: 'password123', kind }).expect(201).then((r) => r.body.id as number);
  const managedBy = async (id: number) => (await q1<any>(pool, 'SELECT managed_by_id FROM users WHERE id = ?', [id]))!.managed_by_id as number | null;

  it('moves chosen retailers, hands over one person’s retailers, and can put them back under the distributor', async () => {
    const a = await admin(); const d = await distributor(a, await staff(a));
    const s1 = await member(d, 'sales'); const s2 = await member(d, 'sales');
    const r1 = await retailer(d, s1); const r2 = await retailer(d, s1); const r3 = await retailer(d);

    const m1 = await request(app).put('/api/v1/distributor/retailers/bulk-manager').set(auth(d.token)).send({ employee_id: s2, retailer_ids: [r1, r3] }).expect(200);
    expect(m1.body.moved).toBe(2);
    expect(await managedBy(r1)).toBe(s2); expect(await managedBy(r3)).toBe(s2); expect(await managedBy(r2)).toBe(s1);

    const m2 = await request(app).put('/api/v1/distributor/retailers/bulk-manager').set(auth(d.token)).send({ employee_id: null, from_employee_id: s2 }).expect(200);
    expect(m2.body.moved).toBe(2);
    expect(await managedBy(r1)).toBeNull(); expect(await managedBy(r2)).toBe(s1);
    const list = (await request(app).get('/api/v1/distributor/retailers').set(auth(d.token)).expect(200)).body.retailers;
    expect(list.find((x: any) => x.id === r2).managed_by_id).toBe(s1);
  });

  it('never touches another distributor’s retailers or team, and employees cannot do it', async () => {
    const a = await admin(); const e = await staff(a);
    const d = await distributor(a, e); const other = await distributor(a, e);
    const mine = await member(d, 'sales'); const theirMember = await member(other, 'delivery');
    const theirRetailer = await retailer(other); const myRetailer = await retailer(d);

    const none = await request(app).put('/api/v1/distributor/retailers/bulk-manager').set(auth(d.token)).send({ employee_id: mine, retailer_ids: [theirRetailer] }).expect(200);
    expect(none.body.moved).toBe(0);
    expect(await managedBy(theirRetailer)).toBeNull();
    expect((await request(app).put('/api/v1/distributor/retailers/bulk-manager').set(auth(d.token)).send({ employee_id: theirMember, retailer_ids: [myRetailer] })).status).toBe(404);
    expect((await request(app).put('/api/v1/distributor/retailers/bulk-manager').set(auth(d.token)).send({ employee_id: mine })).status).toBe(400);

    const memberToken = await (async () => { const p = phone(); await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: p, name: 'Emp', password: 'password123', kind: 'sales' }).expect(201); return login(p); })();
    expect((await request(app).put('/api/v1/distributor/retailers/bulk-manager').set(auth(memberToken)).send({ employee_id: null, retailer_ids: [myRetailer] })).status).toBe(403);
  });
});

describe('sub-categories added by a distributor', () => {
  it('adds a sub-category under their category, returns the same one for a repeat, and the product can use it', async () => {
    const a = await admin(); const d = await distributor(a, await staff(a));
    const sub = (await request(app).post('/api/v1/catalog/categories').set(auth(d.token)).send({ name: 'Basmati', parent_id: d.categoryId }).expect(201)).body;
    expect(sub).toMatchObject({ name: 'Basmati', parent_id: d.categoryId, status: 'pending' });
    const again = (await request(app).post('/api/v1/catalog/categories').set(auth(d.token)).send({ name: ' basmati ', parent_id: d.categoryId }).expect(200)).body;
    expect(again.id).toBe(sub.id);

    const tax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(d.token)).expect(200)).body;
    expect(tax.categories.find((c: any) => c.id === sub.id)?.parent_id).toBe(d.categoryId);
    const p = await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', category_id: sub.id }).expect(201);
    expect(p.body.category).toBe('Basmati');
  });

  it('refuses a parent that is not theirs and needs a name', async () => {
    const a = await admin(); const d = await distributor(a, await staff(a));
    expect((await request(app).post('/api/v1/catalog/categories').set(auth(d.token)).send({ name: 'X', parent_id: 999999 })).status).toBe(400);
    expect((await request(app).post('/api/v1/catalog/categories').set(auth(d.token)).send({ name: '', parent_id: d.categoryId })).status).toBe(400);
  });
});

describe('bulk import with cost, weight and status', () => {
  it('stores purchase price, weight and hidden status, and the error rows are numbered', async () => {
    const a = await admin(); const d = await distributor(a, await staff(a));
    const rows = [
      { name: 'Rice 5kg', price: '420', sku: 'R5', cost: '380', weight_g: '5000', active: 'Inactive', category: undefined },
      { name: 'Dal 1kg', price: '120', sku: 'D1', cost: '100', weight_g: '1000', active: 'Active' },
      { name: 'Bad price', price: 'abc', sku: 'B1' },
    ];
    const r = (await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows, upsert: true }).expect(200)).body;
    expect(r.created).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].row).toBe(3);
    const rice = (await q1<any>(pool, "SELECT cost_paise, weight_g, is_active FROM products WHERE distributor_id = ? AND sku = 'R5'", [d.id]))!;
    expect(rice).toMatchObject({ cost_paise: 38000, weight_g: 5000, is_active: 0 });
    const dal = (await q1<any>(pool, "SELECT is_active FROM products WHERE distributor_id = ? AND sku = 'D1'", [d.id]))!;
    expect(dal.is_active).toBe(1);

    // a second upload updates by SKU instead of duplicating
    const again = (await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [{ name: 'Dal 1kg', price: '125', sku: 'D1', active: 'Inactive' }], upsert: true }).expect(200)).body;
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect((await q1<any>(pool, "SELECT is_active FROM products WHERE distributor_id = ? AND sku = 'D1'", [d.id]))!.is_active).toBe(0);
  });
});

describe('choosing categories when adding a retailer', () => {
  it('offers the distributor’s categories with their sub-categories, to the owner and to a team member', async () => {
    const a = await admin(); const d = await distributor(a, await staff(a));
    const sub = (await request(app).post('/api/v1/catalog/categories').set(auth(d.token)).send({ name: 'Sub One', parent_id: d.categoryId }).expect(201)).body;
    const ownerTax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(d.token)).expect(200)).body;
    expect(ownerTax.restricted).toBe(true);
    expect(ownerTax.categories.map((c: any) => c.id)).toEqual(expect.arrayContaining([d.categoryId, sub.id]));

    const p = phone();
    await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: p, name: 'Sales One', password: 'password123', kind: 'sales' }).expect(201);
    const et = await login(p);
    const empTax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(et)).expect(200)).body;
    expect(empTax.categories.map((c: any) => c.id)).toContain(sub.id);

    // the employee may add a retailer with a sub-category, or with none at all
    const body = (over: object) => ({ phone: phone(), name: 'Keeper', password: 'password123', shop_name: 'Shop ' + n, pincode: '400001', ...over });
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(et)).send(body({}))).status).toBe(201);
    const ok = await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(et)).send(body({ category_ids: [sub.id] })).expect(201);
    expect(ok.body.category_ids).toEqual([sub.id]);

    // the owner's retailer screen lists the same tree
    const mgr = (await request(app).get(`/api/v1/distributor/retailers/${ok.body.id}/categories`).set(auth(d.token)).expect(200)).body;
    expect(mgr.restricted).toBe(true);
    expect(mgr.offered.map((c: any) => c.id)).toEqual(expect.arrayContaining([d.categoryId, sub.id]));
    expect(mgr.categories.map((c: any) => c.id)).toEqual([sub.id]);
  });

  it('a distributor with no categories set up can still pick from every active category, and may pick none', async () => {
    const a = await admin();
    const p = phone();
    const reg = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@c.test`, name: 'Solo', password: 'password123', business_name: 'Solo ' + p }).expect(201);
    const t = reg.body.access_token as string;
    await request(app).post('/api/v1/admin/categories').set(auth(a)).send({ name: 'Open Cat ' + p }).expect(201);
    const tax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(t)).expect(200)).body;
    expect(tax.restricted).toBe(false);
    expect(tax.categories.some((c: any) => c.name === 'Open Cat ' + p)).toBe(true);
    const r = await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(t)).send({ phone: phone(), name: 'Keeper', password: 'password123', shop_name: 'Shop ' + n, pincode: '400001' });
    expect(r.status).toBe(201);
  });
});

describe('a distributor whose only category was retired', () => {
  it('is not stuck on categories when adding a retailer', async () => {
    const a = await admin(); const d = await distributor(a, await staff(a));
    const body = () => ({ phone: phone(), name: 'Keeper', password: 'password123', shop_name: 'Shop ' + n, pincode: '400001' });
    // adding a retailer by hand needs no category, live or retired
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(body())).status).toBe(201);
    await request(app).put(`/api/v1/admin/categories/${d.categoryId}`).set(auth(a)).send({ status: 'retired' }).expect(200);
    const tax = (await request(app).get('/api/v1/catalog/taxonomy').set(auth(d.token)).expect(200)).body;
    expect(tax.restricted).toBe(false);
    expect((await request(app).post('/api/v1/distributor/retailer-accounts').set(auth(d.token)).send(body())).status).toBe(201);
  });
});
