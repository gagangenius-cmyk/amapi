import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { pool, q, q1 } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7000000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function reg(role: 'distributor' | 'retailer', extra: object = {}) {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz <b>' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send({ ...body, ...extra });
  expect(r.status).toBe(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p, email: `${role === 'distributor' ? 'd' : 'r'}${p}@test.local` };
}


/** distributor asks, retailer accepts (the retailer must consent before anything can be posted to their khata) */
async function link(d: { token: string; id: number }, r: { token: string; phone: string }) {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
}

/** distributor + linked retailer + product + an accepted order of 2 x 100.00 @ 18% GST */
async function accepted() {
  const d = await reg('distributor', { gst_no: '27ABCDE1234F1Z5' });
  const r = await reg('retailer');
  await link(d, r);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice <script>', price: '100', stock_qty: 10, gst_rate_bps: 1800, hsn: '1006' })).body.id;
  const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'o1').send({ distributor_id: d.id, items: [{ product_id: pid, qty: 2 }] })).body.order.id;
  await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
  return { d, r, oid };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('operations', () => {
  it('reports readiness and tags every response with a request id', async () => {
    const r = await request(app).get('/ready').expect(200);
    expect(r.body.ready).toBe(true);
    expect((await request(app).get('/health')).headers['x-request-id']).toBeTruthy();
    expect((await request(app).get('/health').set('x-request-id', 'trace-1')).headers['x-request-id']).toBe('trace-1');
  });

  it('writes an audit trail for money and security actions', async () => {
    const { d, r, oid } = await accepted();
    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'nope-nope1' }).expect(401);
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'a1')
      .send({ retailer_id: r.id, transaction_type: 'payment_cash', amount: '100', cash_denominations: { '100': 1 } }).expect(201);
    const pay = await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'p1').send({ distributor_id: d.id, amount: '50', utr: 'UTRAUDIT123' }).expect(201);
    await request(app).post(`/api/v1/payments/${pay.body.payment.id}/confirm`).set(auth(d.token)).expect(200);
    const actions = (await q<any>(pool, 'SELECT action FROM audit_log')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'ledger.payment_cash', 'payment.confirmed']));
    expect(oid).toBeGreaterThan(0);
  });
});

describe('GST invoice', () => {
  it('issues a signed, scoped, escaped invoice with correct tax maths', async () => {
    const { d, r, oid } = await accepted();
    const stranger = await reg('retailer');
    await request(app).get(`/api/v1/orders/${oid}/invoice-link`).set(auth(stranger.token)).expect(404);
    const link = await request(app).get(`/api/v1/orders/${oid}/invoice-link`).set(auth(r.token)).expect(200);
    const path = new URL(link.body.url).pathname + new URL(link.body.url).search;
    const html = (await request(app).get(path).expect(200)).text;
    expect(html).toContain('TAX INVOICE');
    expect(html).toContain('27ABCDE1234F1Z5');
    expect(html).toContain('236.00');            // 200 + 18%
    expect(html).toContain('GST 36.00 in total');  // buyer's GSTIN unknown -> no CGST/SGST/IGST claim
    expect(html).toContain('2026-27/00001'.slice(0, 5)); // sequential per-supplier financial-year number
    expect(html).toMatch(/\d{4}-\d{2}\/00001/);
    expect(html).toContain('1006');
    expect(html).not.toContain('<script>');      // product/business names are HTML-escaped
    expect(html).toContain('&lt;script&gt;');

    await request(app).get(`/api/v1/orders/${oid}/invoice`).expect(401);                    // no token
    await request(app).get(`/api/v1/orders/${oid + 1}/invoice?t=${link.body.url.split('t=')[1]}`).expect(401); // token for another order
    const expired = jwt.sign({ orderId: oid, purpose: 'invoice' }, env.jwtSecret, { expiresIn: -10 });
    await request(app).get(`/api/v1/orders/${oid}/invoice?t=${expired}`).expect(401);
    expect(d.id).toBeGreaterThan(0);
  });

  it('refuses invoices for orders that are not accepted yet', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await request(app).put('/api/v1/distributor/pincodes').set(auth(d.token)).send({ pincodes: ['400001'] }).expect(200);
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'x', price: '1', stock_qty: 5 })).body.id;
    const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'k').send({ distributor_id: d.id, items: [{ product_id: pid, qty: 1 }] })).body.order.id;
    await request(app).get(`/api/v1/orders/${oid}/invoice-link`).set(auth(r.token)).expect(409);
  });
});


describe('GST invoice numbering and tax split', () => {
  it('numbers invoices consecutively per supplier and splits tax by state', async () => {
    const { d, r, oid } = await accepted();
    const first = (await q1<any>(pool, 'SELECT invoice_no FROM orders WHERE id = ?', [oid]))!.invoice_no as string;
    expect(first).toMatch(/^\d{4}-\d{2}\/00001$/);
    // a second order accepted by the same supplier gets 00002
    const pid2 = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'y', price: '10', stock_qty: 9 })).body.id;
    const oid2 = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'o2').send({ distributor_id: d.id, items: [{ product_id: pid2, qty: 1 }] })).body.order.id;
    await request(app).post(`/api/v1/orders/${oid2}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    expect((await q1<any>(pool, 'SELECT invoice_no FROM orders WHERE id = ?', [oid2]))!.invoice_no).toBe(first.replace('00001', '00002'));
    // another supplier starts again at 00001
    const other = await accepted();
    expect((await q1<any>(pool, 'SELECT invoice_no FROM orders WHERE id = ?', [other.oid]))!.invoice_no).toBe(first);
    // rejecting never consumes a number
    const oid3 = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'o3').send({ distributor_id: d.id, items: [{ product_id: pid2, qty: 1 }] })).body.order.id;
    await request(app).post(`/api/v1/orders/${oid3}/transition`).set(auth(d.token)).send({ to: 'rejected' }).expect(200);
    expect((await q1<any>(pool, 'SELECT invoice_no FROM orders WHERE id = ?', [oid3]))!.invoice_no).toBeNull();

    const invoiceHtml = async (orderId: number, token: string) => {
      const link = await request(app).get(`/api/v1/orders/${orderId}/invoice-link`).set(auth(token)).expect(200);
      return (await request(app).get(new URL(link.body.url).pathname + new URL(link.body.url).search).expect(200)).text as string;
    };
    await pool.query("UPDATE retailer_profiles SET gst_no = '27AAAAA0000A1Z5' WHERE user_id = ?", [r.id]);
    expect(await invoiceHtml(oid, r.token)).toContain('Intra-state supply (state 27): CGST 18.00 + SGST 18.00.');
    await pool.query("UPDATE retailer_profiles SET gst_no = '29AAAAA0000A1Z5' WHERE user_id = ?", [r.id]);
    expect(await invoiceHtml(oid, r.token)).toContain('Inter-state supply (27 to 29): IGST 36.00.');
  });
});

describe('reports', () => {
  it('summarises sales, collections and outstanding for the distributor only', async () => {
    const { d, r } = await accepted(); // invoiced 236.00
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'rp1')
      .send({ retailer_id: r.id, transaction_type: 'payment_cash', amount: '36', cash_denominations: { '20': 1, '10': 1, '5': 1, '1': 1 } }).expect(201);
    const s = (await request(app).get('/api/v1/reports/summary').set(auth(d.token)).expect(200)).body;
    expect(s.invoiced).toBe('236.00');
    expect(s.collected).toBe('36.00');
    expect(s.collected_cash).toBe('36.00');
    expect(s.outstanding).toBe('200.00');
    expect(s.orders.accepted.count).toBe(1);
    expect(s.top_debtors[0].due).toBe('200.00');
    await request(app).get('/api/v1/reports/summary').set(auth(r.token)).expect(403);
    await request(app).get('/api/v1/reports/summary?from=not-a-date').set(auth(d.token)).expect(400);
  });
});

describe('privacy', () => {
  it('exports own data and anonymises on deletion, but blocks while money is owed', async () => {
    const { d, r } = await accepted();
    const exp = await request(app).get('/api/v1/me/export').set(auth(r.token)).expect(200);
    expect(exp.body.user.id).toBe(r.id);
    expect(exp.body.orders).toHaveLength(1);
    expect(exp.body.user.password_hash).toBeUndefined();

    await request(app).delete('/api/v1/me').set(auth(r.token)).send({ password: 'wrong-pass1' }).expect(401);
    const blocked = await request(app).delete('/api/v1/me').set(auth(r.token)).send({ password: 'password123' }).expect(409);
    expect(blocked.body.error.code).toBe('OUTSTANDING_BALANCE');

    // settle (cash 236) and deliver, then delete
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'del1')
      .send({ retailer_id: r.id, transaction_type: 'payment_cash', amount: '236', cash_denominations: { '200': 1, '20': 1, '10': 1, '5': 1, '1': 1 } }).expect(201);
    const oid = (await request(app).get('/api/v1/orders').set(auth(r.token))).body.orders[0].id;
    for (const to of ['dispatched', 'out_for_delivery', 'delivered']) await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to }).expect(200);

    await request(app).delete('/api/v1/me').set(auth(r.token)).send({ password: 'password123' }).expect(204);
    const row = await q1<any>(pool, 'SELECT name, phone, is_active FROM users WHERE id = ?', [r.id]);
    expect(row).toMatchObject({ name: 'Deleted user', is_active: 0 });
    expect(row.phone).not.toBe(r.phone);
    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'password123' }).expect(401);
    // financial history is retained
    expect((await q1<any>(pool, 'SELECT COUNT(*) n FROM ledger_transactions WHERE retailer_id = ?', [r.id]))!.n).toBe(2);
  });
});
