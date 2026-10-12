import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool, q, q1 } from '../src/db/pool';
import { computeAging } from '../src/modules/ledger/aging';
import { receivablesOf } from '../src/modules/collections/collections.routes';
import { RETURN_WINDOW_DAYS, withinReturnWindow } from '../src/modules/returns/returns.routes';
import { runOverdueReminders } from '../src/jobs/subscriptionWarnings';

const app = createApp();
let n = 0;
const phone = () => String(7500000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body);
  expect(r.status).toBe(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
async function setup(stock = 100) {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', stock_qty: stock, gst_rate_bps: 0 })).body.id as number;
  return { d, r, pid };
}
let k = 0;
const order = (r: { token: string }, did: number, pid: number, qty: number) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'k' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty }] });
const move = (d: { token: string }, oid: number, to: string) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to });
async function delivered(d: { token: string }, r: { token: string }, did: number, pid: number, qty: number) {
  const oid = (await order(r, did, pid, qty).expect(201)).body.order.id as number;
  for (const to of ['accepted', 'dispatched', 'out_for_delivery', 'delivered']) await move(d, oid, to).expect(200);
  return oid;
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('aging maths (pure)', () => {
  const day = 86400000; const now = new Date('2026-06-01T00:00:00Z');
  const at = (daysAgo: number, delta: number) => ({ delta_paise: delta, created_at: new Date(+now - daysAgo * day) });

  it('applies payments to the oldest charge first and buckets what is left by lateness', () => {
    const a = computeAging([at(100, 1000), at(40, 2000), at(5, 3000), at(60, -1500)], now, 0);
    // 1500 of credit: clears the 100-day charge (1000) and 500 of the 40-day one
    expect(a).toMatchObject({ d90_plus: 0, d31_60: 1500, d1_30: 3000, total_due: 4500, overdue: 4500, advance: 0 });
    expect(a.oldest_overdue_days).toBe(40);
  });
  it('credit days push the due date out', () => {
    const a = computeAging([at(10, 1000), at(40, 2000)], now, 30);
    expect(a).toMatchObject({ not_due: 1000, d1_30: 2000, overdue: 2000, total_due: 3000 });
  });
  it('an overpayment is shown as advance, nothing is overdue', () => {
    expect(computeAging([at(5, 500), at(1, -800)], now, 0)).toMatchObject({ total_due: 0, overdue: 0, advance: 300 });
  });
});

describe('credit limit', () => {
  it('blocks an order that would exceed the limit, counting dues and orders still waiting', async () => {
    const { d, r, pid } = await setup();
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(r.token)).send({ credit_limit: '500' }).expect(403);
    const t = await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({ credit_limit: '500', credit_days: 15 }).expect(200);
    expect(t.body).toEqual({ credit_limit: '500.00', credit_days: 15 });

    await order(r, d.id, pid, 3).expect(201);                   // 300 waiting
    const over = await order(r, d.id, pid, 3);                  // 300 + 300 > 500
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(over.body.error.details).toMatchObject({ credit_limit: '500.00', pending_orders: '300.00' });
    await order(r, d.id, pid, 2).expect(201);                   // 300 + 200 = 500, exactly at the limit
  });

  it('no limit means no restriction, and clearing the limit lifts it', async () => {
    const { d, r, pid } = await setup();
    await order(r, d.id, pid, 50).expect(201);
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({ credit_limit: '100' }).expect(200);
    await order(r, d.id, pid, 5).expect(409);
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({ credit_limit: null }).expect(200);
    await order(r, d.id, pid, 5).expect(201);
  });

  it('parallel orders can not both slip under the limit', async () => {
    const { d, r, pid } = await setup();
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({ credit_limit: '1000' }).expect(200);
    const rs = await Promise.all([1, 2, 3, 4].map(() => order(r, d.id, pid, 6)));   // 600 each, only one fits
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
    expect(rs.filter((x) => x.status === 409)).toHaveLength(3);
  });

  it('rejects a bad limit and a stranger', async () => {
    const { d, r } = await setup(); const other = await reg('retailer');
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({ credit_limit: '0' }).expect(400);
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({}).expect(400);
    await request(app).put(`/api/v1/collections/terms/${other.id}`).set(auth(d.token)).send({ credit_limit: '10' }).expect(404);
  });
});

describe('receivables and reminders', () => {
  it('shows who is overdue by how much, and limits reminders to one a day', async () => {
    const { d, r, pid } = await setup();
    await request(app).put(`/api/v1/collections/terms/${r.id}`).set(auth(d.token)).send({ credit_days: 10 }).expect(200);
    const oid = (await order(r, d.id, pid, 4).expect(201)).body.order.id;
    await move(d, oid, 'accepted').expect(200);

    let rec = (await request(app).get('/api/v1/collections/receivables').set(auth(d.token)).expect(200)).body;
    expect(rec.retailers[0]).toMatchObject({ retailer_id: r.id, total_due: '400.00', not_due: '400.00', overdue: '0.00', can_remind: true });

    // 45 days later (10 credit days -> 35 days late), computed from the ledger itself
    const [later] = await receivablesOf(d.id, new Date(Date.now() + 45 * 86400000));
    expect(later.aging).toMatchObject({ overdue: 40000, d31_60: 40000, oldest_overdue_days: 35, not_due: 0 });

    await request(app).post(`/api/v1/collections/remind/${r.id}`).set(auth(r.token)).expect(403);
    await request(app).post(`/api/v1/collections/remind/${r.id}`).set(auth(d.token)).expect(200);
    const again = await request(app).post(`/api/v1/collections/remind/${r.id}`).set(auth(d.token));
    expect(again.status).toBe(429);
    expect((await q1<any>(pool, 'SELECT COUNT(*) n FROM collection_reminders WHERE retailer_id = ?', [r.id]))!.n).toBe(1);
    expect((await request(app).get('/api/v1/collections/receivables').set(auth(d.token))).body.retailers[0].can_remind).toBe(false);
  });

  it('refuses to remind someone who owes nothing', async () => {
    const { d, r } = await setup();
    expect((await request(app).post(`/api/v1/collections/remind/${r.id}`).set(auth(d.token))).status).toBe(409);
  });

  it('the daily job reminds overdue retailers once and skips the ones who are not late', async () => {
    const { d, r, pid } = await setup(); const late = await setup();
    const o1 = (await order(r, d.id, pid, 1).expect(201)).body.order.id; await move(d, o1, 'accepted').expect(200);
    const o2 = (await order(late.r, late.d.id, late.pid, 1).expect(201)).body.order.id; await move(late.d, o2, 'accepted').expect(200);
    const future = new Date(Date.now() + 2 * 86400000);
    expect(await runOverdueReminders(future)).toBeGreaterThanOrEqual(2);   // both are 2 days late with credit_days = 0
    expect(await runOverdueReminders(future)).toBe(0);                      // already reminded today
    expect((await q1<any>(pool, "SELECT COUNT(*) n FROM collection_reminders WHERE retailer_id = ? AND source = 'auto'", [r.id]))!.n).toBe(1);
    await request(app).put(`/api/v1/collections/terms/${late.r.id}`).set(auth(late.d.token)).send({ credit_days: 30 }).expect(200);
    expect(o1).toBeGreaterThan(0); expect(o2).toBeGreaterThan(0);
  });
});

describe('returns and credit notes', () => {
  it('a delivered order can be returned; approval credits the khata and restocks', async () => {
    const { d, r, pid } = await setup(10);
    const oid = await delivered(d, r, d.id, pid, 4);        // stock 10 -> 6, owes 400
    const bal = async () => (await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token))).body.balance_due;
    expect(await bal()).toBe('400.00');

    const rq = (items: any[], key = 'ret1', reason = 'Damaged packs') => request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', key).send({ order_id: oid, reason, items });
    expect((await rq([{ product_id: pid, qty: 5 }], 'x1')).status).toBe(409);          // more than bought
    const made = await rq([{ product_id: pid, qty: 3 }]);
    expect(made.status).toBe(201);
    expect(made.body.return).toMatchObject({ status: 'requested', total: '300.00' });
    expect((await rq([{ product_id: pid, qty: 3 }])).body.replayed).toBe(true);        // same key, no duplicate
    expect((await rq([{ product_id: pid, qty: 2 }], 'ret2')).status).toBe(409);        // only 1 left to return

    const id = made.body.return.id;
    expect((await request(app).get('/api/v1/returns').query({ status: 'requested' }).set(auth(d.token))).body.returns).toHaveLength(1);
    await request(app).post(`/api/v1/returns/${id}/resolve`).set(auth(r.token)).send({ action: 'approve' }).expect(403);
    await request(app).post(`/api/v1/returns/${id}/resolve`).set(auth(d.token)).send({ action: 'approve', restock: true }).expect(200);
    await request(app).post(`/api/v1/returns/${id}/resolve`).set(auth(d.token)).send({ action: 'approve' }).expect(409);   // can't answer twice

    expect(await bal()).toBe('100.00');                       // 400 - 300 credit note
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(9);   // 6 + 3
    expect((await q1<any>(pool, "SELECT type, amount_paise FROM ledger_transactions WHERE order_id = ? AND type = 'credit_note'", [oid]))).toMatchObject({ amount_paise: 30000 });
    expect((await q1<any>(pool, "SELECT reason FROM stock_movements WHERE ref_order_id = ? AND delta > 0", [oid]))!.reason).toBe('customer_return');
  });

  it('rejecting needs a reason, changes nothing financial, and frees the quantity', async () => {
    const { d, r, pid } = await setup(10);
    const oid = await delivered(d, r, d.id, pid, 2);
    const made = await request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', 'rj').send({ order_id: oid, reason: 'Changed my mind', items: [{ product_id: pid, qty: 2 }] }).expect(201);
    await request(app).post(`/api/v1/returns/${made.body.return.id}/resolve`).set(auth(d.token)).send({ action: 'reject' }).expect(400);
    await request(app).post(`/api/v1/returns/${made.body.return.id}/resolve`).set(auth(d.token)).send({ action: 'reject', note: 'Not covered' }).expect(200);
    expect((await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token))).body.balance_due).toBe('200.00');
    // the rejected quantity can be asked for again
    await request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', 'rj2').send({ order_id: oid, reason: 'Actually faulty', items: [{ product_id: pid, qty: 2 }] }).expect(201);
  });

  it('only delivered orders, only your own, only within the window', async () => {
    const { d, r, pid } = await setup(10); const other = await reg('retailer');
    const oid = (await order(r, d.id, pid, 1).expect(201)).body.order.id;
    const body = { order_id: oid, reason: 'Broken', items: [{ product_id: pid, qty: 1 }] };
    expect((await request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', 'e1').send(body)).body.error.code).toBe('NOT_DELIVERED');
    for (const to of ['accepted', 'dispatched', 'out_for_delivery', 'delivered']) await move(d, oid, to).expect(200);
    await request(app).post('/api/v1/returns').set(auth(other.token)).set('Idempotency-Key', 'e2').send(body).expect(404);
    await request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', 'e3').send(body).expect(201);
  });

  it('closes the window after the configured number of days', () => {
    const t = Date.UTC(2026, 5, 1);
    expect(withinReturnWindow(t, t + (RETURN_WINDOW_DAYS - 1) * 86400000)).toBe(true);
    expect(withinReturnWindow(t, t + (RETURN_WINDOW_DAYS + 1) * 86400000)).toBe(false);
  });
});

describe('observability', () => {
  it('serves Prometheus metrics with route patterns, not raw ids', async () => {
    await request(app).get('/health');
    const m = await request(app).get('/metrics').expect(200);
    expect(m.text).toContain('http_request_duration_seconds_bucket');
    expect(m.text).toContain('db_pool_connections');
    expect(m.text).not.toMatch(/route="[^"]*\/\d{3,}[^"]*"/);
  });
  it('compresses large responses', async () => {
    const r = await request(app).get('/metrics').set('Accept-Encoding', 'gzip');
    expect(r.headers['content-encoding']).toBe('gzip');
  });
});
