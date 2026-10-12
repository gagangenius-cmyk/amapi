import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';
import { signAccess } from '../src/middleware/auth';
import { runExpiryWarnings } from '../src/jobs/subscriptionWarnings';
import { fromPaise, toPaise, withGst } from '../src/utils/money';

const app = createApp();
let n = 0;
const phone = () => String(9000000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function registerDistributor(name = 'Sharma Stores') {
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: phone(), email: `d${n}@test.local`, name: 'Owner', password: 'password123', business_name: name });
  expect(r.status).toBe(201);
  // a distributor only sells where it says it does: by default the pincode the test retailers live in
  await request(app).put('/api/v1/distributor/pincodes').set(auth(r.body.access_token)).send({ pincodes: ['400001'] }).expect(200);
  return { id: r.body.id as number, token: r.body.access_token as string };
}
async function registerRetailer(pincode = '400001') {
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: phone(), email: `r${n}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Corner Shop', pincode });
  expect(r.status).toBe(201);
  return { id: r.body.id as number, token: r.body.access_token as string };
}
async function addProduct(token: string, price: string | number = '100.00', stock = 100, gst = 1800) {
  const r = await request(app).post('/api/v1/catalog').set(auth(token)).send({ name: 'Rice 25kg', price, stock_qty: stock, gst_rate_bps: gst });
  expect(r.status).toBe(201);
  return r.body.id as number;
}
async function placeOrder(token: string, distributorId: number, productId: number, qty = 2, key = `o-${Math.random()}`) {
  return request(app).post('/api/v1/orders').set(auth(token)).set('Idempotency-Key', key).send({ distributor_id: distributorId, items: [{ product_id: productId, qty }] });
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('money', () => {
  it('parses and formats paise exactly', () => {
    expect(toPaise('5000')).toBe(500000);
    expect(toPaise('0.1')).toBe(10);
    expect(toPaise(19.99)).toBe(1999);
    expect(fromPaise(-1050)).toBe('-10.50');
    expect(() => toPaise('1.234')).toThrow();
    expect(() => toPaise('-5')).toThrow();
    expect(withGst(10000, 1800)).toBe(11800);
  });
});

describe('auth', () => {
  it('rejects bad creds, rotates refresh tokens and detects reuse', async () => {
    const p = phone();
    await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `x${p}@test.local`, name: 'X Y', password: 'password123', shop_name: 'S1', pincode: '400001' }).expect(201);
    await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'wrongwrong' }).expect(401);
    const login = await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200);
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token }).expect(200);
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token }).expect(401); // reuse
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: r1.body.refresh_token }).expect(401); // family revoked
    await request(app).get('/api/v1/orders').expect(401);
  });
});

describe('storefront', () => {
  it('pins primary first and lists others by pincode', async () => {
    const d1 = await registerDistributor('Primary Co');
    const d2 = await registerDistributor('Other Co');
    for (const d of [d1, d2]) await request(app).put('/api/v1/distributor/pincodes').set(auth(d.token)).send({ pincodes: ['560001'] }).expect(200);
    await addProduct(d1.token);
    const ret = await registerRetailer('560001');
    await request(app).put('/api/v1/retailer/primary').set(auth(ret.token)).send({ distributor_id: d1.id }).expect(200);
    const s = await request(app).get('/api/v1/retailer/stores').set(auth(ret.token)).expect(200);
    expect(s.body.primary_distributor.id).toBe(d1.id);
    expect(s.body.primary_distributor.is_pinned).toBe(true);
    expect(s.body.primary_distributor.products).toHaveLength(1);
    expect(s.body.other_distributors.map((o: any) => o.id)).toEqual([d2.id]);
    expect(s.body.other_distributors[0].commission_applicable).toBe(true);
    const mine = await request(app).get('/api/v1/retailer/distributors').set(auth(ret.token)).expect(200);
    expect(mine.body.distributors).toEqual([{ id: d1.id, business_name: 'Primary Co', is_primary: true, balance_due: '0.00' }]);
  });
});

describe('order + ledger flow', () => {
  it('place -> accept (invoice, stock) -> cash payment with denominations -> statement', async () => {
    const d = await registerDistributor();
    const ret = await registerRetailer();
    await request(app).put('/api/v1/retailer/primary').set(auth(ret.token)).send({ distributor_id: d.id }).expect(200);
    const pid = await addProduct(d.token, '100.00', 10, 1800);

    expect((await request(app).post('/api/v1/orders').set(auth(ret.token)).send({})).status).toBe(400); // idempotency key required
    const o = await placeOrder(ret.token, d.id, pid, 2, 'k1');
    expect(o.status).toBe(201);
    expect(o.body.order.total).toBe('236.00'); // 2*100 + 18% GST
    expect(o.body.order.is_out_of_hierarchy).toBe(false);
    const replay = await placeOrder(ret.token, d.id, pid, 2, 'k1');
    expect(replay.status).toBe(200);
    expect(replay.body.order.id).toBe(o.body.order.id);

    const oid = o.body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(ret.token)).send({ to: 'accepted' }).expect(403);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'delivered' }).expect(409);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(8);

    let st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: ret.id }).set(auth(d.token)).expect(200);
    expect(st.body.balance_due).toBe('236.00');
    expect(st.body.transactions[0].type).toBe('invoice');

    // denominations must sum to amount
    const bad = { retailer_id: ret.id, transaction_type: 'payment_cash', amount: '100', cash_denominations: { '500': 1 } };
    const r1 = await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c0').send(bad);
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('DENOMINATION_MISMATCH');
    expect((await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c0b').send({ ...bad, cash_denominations: { '7': 1 } })).status).toBe(400);

    const pay = { retailer_id: ret.id, transaction_type: 'payment_cash', amount: '200.00', cash_denominations: { '100': 1, '50': 2 }, notes: 'weekly' };
    const p1 = await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c1').send(pay).expect(201);
    expect(p1.body.transaction.balance_after).toBe('36.00');
    const p2 = await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c1').send(pay).expect(200);
    expect(p2.body.replayed).toBe(true);
    // same key, different payload -> conflict
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c1').send({ ...pay, amount: '100', cash_denominations: { '100': 1 } }).expect(422);

    st = await request(app).get('/api/v1/ledger/statement').query({ distributor_id: d.id }).set(auth(ret.token)).expect(200);
    expect(st.body.balance_due).toBe('36.00');
    expect(st.body.transactions).toHaveLength(2);
  });

  it('serializes concurrent postings: balance equals the sum, balance_after is a clean chain', async () => {
    const d = await registerDistributor();
    const ret = await registerRetailer();
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: (await q1<any>(pool, 'SELECT phone FROM users WHERE id = ?', [ret.id]))!.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(ret.token)).expect(200);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', `par-${i}`)
          .send({ retailer_id: ret.id, transaction_type: 'debit_note', amount: '10.00' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: ret.id }).set(auth(d.token)).expect(200);
    expect(st.body.balance_due).toBe('120.00');
    const balances = st.body.transactions.map((t: any) => t.balance_after).reverse();
    expect(balances).toEqual(Array.from({ length: 12 }, (_, i) => `${(i + 1) * 10}.00`));
  });

  it('cancelling an accepted order restores stock and reverses the invoice exactly once', async () => {
    const d = await registerDistributor();
    const ret = await registerRetailer();
    await request(app).put('/api/v1/retailer/primary').set(auth(ret.token)).send({ distributor_id: d.id });
    const pid = await addProduct(d.token, '50', 5, 0);
    const oid = (await placeOrder(ret.token, d.id, pid, 3)).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'cancelled' }).expect(200);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(5);
    const st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: ret.id }).set(auth(d.token));
    expect(st.body.balance_due).toBe('0.00');
    const invoice = st.body.transactions.find((t: any) => t.type === 'invoice');
    await request(app).post(`/api/v1/ledger/transaction/${invoice.id}/reverse`).set(auth(d.token)).set('Idempotency-Key', 'rev2').expect(409);
  });

  it('refuses to oversell', async () => {
    const d = await registerDistributor();
    const ret = await registerRetailer();
    const pid = await addProduct(d.token, '10', 2, 0);
    expect((await placeOrder(ret.token, d.id, pid, 3)).status).toBe(409);
  });

  it('flags out-of-hierarchy orders and snapshots commission', async () => {
    const primary = await registerDistributor();
    const other = await registerDistributor();
    const ret = await registerRetailer();
    await request(app).put('/api/v1/retailer/primary').set(auth(ret.token)).send({ distributor_id: primary.id });
    await request(app).put('/api/v1/distributor/pincodes').set(auth(other.token)).send({ pincodes: ['400001'] }).expect(200);
    const pid = await addProduct(other.token, '10', 5, 0);
    const o = await placeOrder(ret.token, other.id, pid, 1);
    expect(o.body.order.is_out_of_hierarchy).toBe(true);
    expect(o.body.order.commission_rate_bps).toBe(200);
  });
});

describe('tenant isolation & roles', () => {
  it('blocks cross-tenant access and limits employees', async () => {
    const d1 = await registerDistributor();
    const d2 = await registerDistributor();
    const ret = await registerRetailer();
    await request(app).put('/api/v1/retailer/primary').set(auth(ret.token)).send({ distributor_id: d1.id });
    const pid = await addProduct(d1.token, '10', 50, 0);
    const oid = (await placeOrder(ret.token, d1.id, pid, 1)).body.order.id;

    await request(app).get(`/api/v1/orders/${oid}`).set(auth(d2.token)).expect(404);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d2.token)).send({ to: 'accepted' }).expect(404);
    await request(app).post('/api/v1/ledger/transaction').set(auth(d2.token)).set('Idempotency-Key', 'x1')
      .send({ retailer_id: ret.id, transaction_type: 'debit_note', amount: '5' }).expect(404); // no relation with d2
    await request(app).post('/api/v1/ledger/transaction').set(auth(d2.token)).set('Idempotency-Key', 'x2')
      .send({ distributor_id: d1.id, retailer_id: ret.id, transaction_type: 'debit_note', amount: '5' }).expect(403);
    await request(app).put('/api/v1/distributor/pincodes').set(auth(ret.token)).send({ pincodes: [] }).expect(403);

    // employee: delivery only for assigned orders; cash collection only
    const ephone = phone();
    const emp = await request(app).post('/api/v1/distributor/employees').set(auth(d1.token)).send({ phone: ephone, name: 'Agent', password: 'password123' }).expect(201);
    const eTok = (await request(app).post('/api/v1/auth/login').send({ phone: ephone, password: 'password123' })).body.access_token;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d1.token)).send({ to: 'accepted' }).expect(200);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(eTok)).send({ to: 'dispatched' }).expect(403); // not assigned
    await request(app).post(`/api/v1/orders/${oid}/assign`).set(auth(d1.token)).send({ employee_id: emp.body.id }).expect(200);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(eTok)).send({ to: 'dispatched' }).expect(200);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(eTok)).send({ to: 'out_for_delivery' }).expect(200);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(eTok)).send({ to: 'delivered' }).expect(200);
    await request(app).post('/api/v1/ledger/transaction').set(auth(eTok)).set('Idempotency-Key', 'e1')
      .send({ retailer_id: ret.id, transaction_type: 'credit_note', amount: '5' }).expect(403);
    await request(app).post('/api/v1/ledger/transaction').set(auth(eTok)).set('Idempotency-Key', 'e2')
      .send({ retailer_id: ret.id, transaction_type: 'payment_cash', amount: '10', cash_denominations: { '10': 1 } }).expect(201);
  });
});

describe('subscription & permissions', () => {
  it('blocks expired distributors, honors khatabook flag, and warns once', async () => {
    const d = await registerDistributor();
    const ret = await registerRetailer();
    await request(app).put('/api/v1/retailer/primary').set(auth(ret.token)).send({ distributor_id: d.id });
    const pid = await addProduct(d.token);

    // expiring in 3 days -> exactly one warning
    await exec(pool, 'UPDATE distributor_profiles SET subscription_ends_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 3 DAY) WHERE user_id = ?', [d.id]);
    expect(await runExpiryWarnings()).toContain(d.id);
    expect(await runExpiryWarnings()).not.toContain(d.id);

    // khatabook disabled by admin -> posting forbidden
    const admin = phone();
    await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin', ?, 'A', 'x')", [admin]);
    const aid = (await q1<any>(pool, 'SELECT id FROM users WHERE phone = ?', [admin]))!.id;
    const jwt = signAccess({ userId: aid, role: 'admin' });
    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(jwt)).send({ permissions: { khatabook_enabled: false } }).expect(200);
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'f1')
      .send({ retailer_id: ret.id, transaction_type: 'debit_note', amount: '5' }).expect(403);
    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(d.token)).send({ extend_days: 5 }).expect(403);

    // expired -> writes rejected (402), retailer can't order
    await exec(pool, 'UPDATE distributor_profiles SET subscription_ends_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE user_id = ?', [d.id]);
    await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'x', price: '1' }).expect(402);
    expect((await placeOrder(ret.token, d.id, pid)).status).toBe(402);

    // admin extension revives it
    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(jwt)).send({ extend_days: 30 }).expect(200);
    expect((await placeOrder(ret.token, d.id, pid)).status).toBe(201);
  });
});
