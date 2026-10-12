import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { computeAging, invoiceLines } from '../src/modules/ledger/aging';

const app = createApp();
let n = 0;
const phone = () => String(7100000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const day = 86400000; const now = new Date('2026-06-01T00:00:00Z');
const at = (daysAgo: number, delta: number, extra: object = {}) => ({ delta_paise: delta, created_at: new Date(+now - daysAgo * day), ...extra });

describe('invoice-by-invoice maths', () => {
  it('applies payments to the oldest bill first and reports paid / part-paid / unpaid / overdue', () => {
    const r = invoiceLines([at(40, 1000, { id: 1 }), at(20, 2000, { id: 2 }), at(5, 3000, { id: 3 }), at(3, -1500, { id: 4 })], now, 30).lines;
    expect(r.map((l) => [l.id, l.amount, l.paid, l.outstanding, l.status])).toEqual([
      [1, 1000, 1000, 0, 'paid'], [2, 2000, 500, 1500, 'overdue'] /* 20 days old, due after 30: not yet overdue? see below */, [3, 3000, 0, 3000, 'unpaid'],
    ].map((row, i) => (i === 1 ? [2, 2000, 500, 1500, 'partial'] : row)));
  });

  it('a cancelled bill disappears together with its reversal and does not eat other payments', () => {
    const entries = [at(10, 1000, { id: 1 }), at(9, 500, { id: 2 }), at(8, -1000, { id: 3, reversal_of: 1 }), at(2, -200, { id: 4 })];
    const { lines, cancelled } = invoiceLines(entries, now, 0);
    expect(cancelled.map((c) => c.id)).toEqual([1]);
    expect(lines.map((l) => [l.id, l.paid, l.outstanding])).toEqual([[2, 200, 300]]);   // the 200 payment belongs to invoice 2, not to the cancelled one
    expect(computeAging(entries, now, 0)).toMatchObject({ total_due: 300, overdue: 300 });
  });

  it('a reversed payment puts the debt back', () => {
    const entries = [at(10, 1000, { id: 1 }), at(5, -1000, { id: 2 }), at(4, 1000, { id: 3, reversal_of: 2 })];
    expect(invoiceLines(entries, now, 0).lines.map((l) => [l.id, l.outstanding])).toEqual([[1, 1000]]);   // the payment and its reversal cancel out
  });
});

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
let k = 0;
beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('GET /ledger/invoices', () => {
  it('shows each bill with its amount, what came in, and what is left - for owner, delivery staff and retailer', async () => {
    const d = await reg('distributor'); const r = await reg('retailer'); const other = await reg('retailer');
    await request(app).put('/api/v1/distributor/pincodes').set(auth(d.token)).send({ pincodes: ['400001'] });
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    const emp = await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: phone(), name: 'Delivery Boy', password: 'password123' }).expect(201);
    const empLogin = (await request(app).post('/api/v1/auth/login').send({ phone: emp.body.phone, password: 'password123' })).body.access_token;
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', stock_qty: 100 })).body.id;

    const bill = async (qty: number) => {
      const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'iv-' + ++k).send({ distributor_id: d.id, items: [{ product_id: pid, qty }] }).expect(201)).body.order.id;
      await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
      return oid;
    };
    const o1 = await bill(5);   // Rs 500
    const o2 = await bill(3);   // Rs 300
    // the delivery employee collects Rs 600 cash (assigned to nothing; collecting cash is allowed)
    await request(app).post('/api/v1/ledger/transaction').set(auth(empLogin)).set('Idempotency-Key', 'iv-cash').send({ retailer_id: r.id, transaction_type: 'payment_cash', amount: '600', cash_denominations: { '500': 1, '100': 1 } }).expect(201);

    const owner = (await request(app).get('/api/v1/ledger/invoices').query({ retailer_id: r.id }).set(auth(d.token)).expect(200)).body;
    expect(owner.totals).toMatchObject({ invoiced: '800.00', received: '600.00', outstanding: '200.00', balance_due: '200.00' });
    expect(owner.invoices.map((i: any) => [i.order_id, i.amount, i.paid, i.outstanding, i.status])).toEqual([
      [o2, '300.00', '100.00', '200.00', 'partial'],
      [o1, '500.00', '500.00', '0.00', 'paid'],
    ]);
    expect(owner.invoices[0].invoice_no).toMatch(/^\d{4}-\d{2}\/\d{5}$/);

    const open = (await request(app).get('/api/v1/ledger/invoices').query({ retailer_id: r.id, status: 'open' }).set(auth(empLogin)).expect(200)).body;
    expect(open.invoices).toHaveLength(1);                                           // delivery staff see it too
    const mine = (await request(app).get('/api/v1/ledger/invoices').query({ distributor_id: d.id }).set(auth(r.token)).expect(200)).body;
    expect(mine.totals.outstanding).toBe('200.00');
    await request(app).get('/api/v1/ledger/invoices').query({ distributor_id: d.id }).set(auth(other.token)).expect(404);   // someone else's khata
    await request(app).get('/api/v1/ledger/invoices').set(auth(r.token)).expect(400);

    // cancelling an invoice shows it as cancelled and the remaining bill keeps its payment
    await request(app).post(`/api/v1/orders/${o1}/transition`).set(auth(d.token)).send({ to: 'cancelled' }).expect(200);
    const after = (await request(app).get('/api/v1/ledger/invoices').query({ retailer_id: r.id }).set(auth(d.token))).body;
    expect(after.invoices.find((i: any) => i.order_id === o1).status).toBe('cancelled');
    // the two views always agree: what is still due, minus any advance, is the khata balance (here Rs 300 paid in advance)
    expect(after.totals).toMatchObject({ outstanding: '0.00', advance: '300.00', balance_due: '-300.00' });
    expect(Number(after.totals.outstanding) - Number(after.totals.advance)).toBe(Number(after.totals.balance_due));
  });
});
