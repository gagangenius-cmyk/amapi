import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q, q1, withTx } from '../src/db/pool';
import { amountFor, earnCommission, pickRule, RuleRow } from '../src/modules/commission/commission.service';

const app = createApp();
let n = 0;
const phone = () => String(7800000000 + 900000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const today = () => new Date().toISOString().slice(0, 10);

async function admin() {
  const p = phone();
  const r = await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  const t = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
  return { id: r.insertId as number, token: t };
}
async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = (await request(app).post('/api/v1/auth/register').send(body).expect(201)).body;
  return { id: r.id as number, token: r.access_token as string, phone: p };
}
let k = 0;
const place = (r: { token: string }, did: number, items: { product_id: number; qty: number }[]) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'cm' + ++k).send({ distributor_id: did, items });
const move = (d: { token: string }, oid: number, to: string) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to });
const deliver = async (d: { token: string }, oid: number) => { for (const to of ['accepted', 'dispatched', 'out_for_delivery', 'delivered']) await move(d, oid, to).expect(200); };
const entries = (orderId: number) => q<any>(pool, 'SELECT * FROM commission_entries WHERE order_id = ? ORDER BY id', [orderId]);

/** A retailer whose home distributor is someone else, ordering from `d` found by pincode: an outside order that carries commission. */
async function outside() {
  const d = await reg('distributor'); const home = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(home.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${home.id}/accept`).set(auth(r.token)).expect(200);
  await request(app).put('/api/v1/distributor/pincodes').set(auth(d.token)).send({ pincodes: ['400001'] }).expect(200);
  const product = async (over: object = {}) =>
    (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Item ' + ++n, price: '100', stock_qty: 500, gst_rate_bps: 1800, ...over }).expect(201)).body;
  return { d, home, r, product };
}

beforeAll(async () => { await migrate(true); });
// rules are platform-wide, so each test starts with none: otherwise one test's rule would price the next test's orders
beforeEach(async () => { await exec(pool, 'DELETE FROM commission_rules'); });
afterAll(async () => { await pool.end(); });

describe('rule matching (pure)', () => {
  const rule = (o: Partial<RuleRow> & { id: number }): RuleRow => ({ distributor_id: null, category_id: null, product_id: null, mode: 'percent', value: 300, priority: 0, ...o });
  const at = { distributorId: 7, productId: 11, categoryId: 5 };

  it('the most specific rule wins: product, then category, then everything; this distributor over all distributors', () => {
    const rules = [
      rule({ id: 1 }),                                                    // everyone, everything
      rule({ id: 2, category_id: 5 }),                                    // everyone, this category
      rule({ id: 3, distributor_id: 7 }),                                 // this distributor, everything
      rule({ id: 4, distributor_id: 7, category_id: 5 }),                 // this distributor, this category
      rule({ id: 5, product_id: 11 }),                                    // everyone, this product
    ];
    expect(pickRule(rules, at)?.id).toBe(5);                              // product beats a distributor+category rule (4 vs 3)
    expect(pickRule(rules.slice(0, 4), at)?.id).toBe(4);
    expect(pickRule(rules.slice(0, 3), at)?.id).toBe(2);                    // category (2) beats distributor-only (1)
    expect(pickRule([rules[0], rules[2]], at)?.id).toBe(3);
    expect(pickRule([rules[0]], at)?.id).toBe(1);
  });

  it('ignores rules for another distributor, product or category, then falls back to priority and id', () => {
    expect(pickRule([rule({ id: 1, distributor_id: 9 }), rule({ id: 2, product_id: 99 }), rule({ id: 3, category_id: 4 })], at)).toBeNull();
    expect(pickRule([rule({ id: 1, priority: 1 }), rule({ id: 2, priority: 5 })], at)?.id).toBe(2);
    expect(pickRule([rule({ id: 8 }), rule({ id: 3 })], at)?.id).toBe(3);
    expect(pickRule([rule({ id: 1, category_id: 5 })], { ...at, categoryId: null })).toBeNull();
  });

  it('computes percent of the value and fixed per unit', () => {
    expect(amountFor('percent', 200, 10000, 10)).toBe(2000);        // 2% of 1000.00
    expect(amountFor('percent', 250, 3333, 3)).toBe(250);           // 2.5% of 99.99 = 2.4998 -> 2.50
    expect(amountFor('fixed_unit', 400, 99999, 6)).toBe(2400);
  });
});

describe('earning commission', () => {
  it('accrues on delivery, on the value excluding GST, only for outside orders', async () => {
    const s = await outside();
    const p = await s.product();                                         // 100 + 18% GST, distributor rate 2%
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    expect(o.is_out_of_hierarchy).toBe(true);
    expect(await entries(o.id)).toHaveLength(0);                         // nothing at placement
    await move(s.d, o.id, 'accepted').expect(200);
    expect(await entries(o.id)).toHaveLength(0);                         // nor at acceptance
    for (const to of ['dispatched', 'out_for_delivery', 'delivered']) await move(s.d, o.id, to).expect(200);

    const e = await entries(o.id);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'earned', mode: 'percent', value: 200 });
    expect(Number(e[0].basis_paise)).toBe(100000);                       // 10 x 100.00, GST excluded
    expect(Number(e[0].amount_paise)).toBe(2000);                        // 2% -> 20.00 (not 23.60)
    expect(e[0].settlement_id).toBeNull();
  });

  it('an order inside the hierarchy earns nothing', async () => {
    const s = await outside();
    const p = await s.product();
    await request(app).post('/api/v1/distributor/retailers').set(auth(s.d.token)).send({ phone: s.r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${s.d.id}/accept`).set(auth(s.r.token)).expect(200);
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 2 }]).expect(201)).body.order;
    expect(o.is_out_of_hierarchy).toBe(false);
    await deliver(s.d, o.id);
    expect(await entries(o.id)).toHaveLength(0);
  });

  it('a retried delivery event cannot create a second entry', async () => {
    const s = await outside();
    const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 3 }]).expect(201)).body.order;
    await deliver(s.d, o.id);
    await withTx((c) => earnCommission(c, o.id));
    await withTx((c) => earnCommission(c, o.id));
    expect(await entries(o.id)).toHaveLength(1);
  });

  it('partial acceptance earns on what was shipped', async () => {
    const s = await outside();
    const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    await request(app).post(`/api/v1/orders/${o.id}/transition`).set(auth(s.d.token)).send({ to: 'accepted', items: [{ product_id: p.id, qty: 4 }] }).expect(200);
    for (const to of ['dispatched', 'out_for_delivery', 'delivered']) await move(s.d, o.id, to).expect(200);
    expect(Number((await entries(o.id))[0].amount_paise)).toBe(800);     // 2% of 4 x 100.00
  });
});

describe('commission rules', () => {
  it('applies the most specific rule, snapshotted when the order is placed', async () => {
    const a = await admin(); const s = await outside();
    const cat = (await request(app).post('/api/v1/admin/categories').set(auth(a.token)).send({ name: 'Edible Oils' }).expect(201)).body;
    const oil = await s.product({ category_id: cat.id });
    const rice = await s.product();
    const soap = await s.product();

    const mk = (b: object) => request(app).post('/api/v1/admin/commission/rules').set(auth(a.token)).send(b).expect(201);
    await mk({ percent: 3 });                                                                // everyone, everything
    await mk({ percent: 5, category_id: cat.id });                                           // oils
    await mk({ fixed_per_unit: '4', product_id: rice.id, distributor_id: s.d.id });          // this product: Rs 4 a unit

    const o = (await place(s.r, s.d.id, [{ product_id: oil.id, qty: 10 }, { product_id: rice.id, qty: 10 }, { product_id: soap.id, qty: 10 }]).expect(201)).body.order;
    await deliver(s.d, o.id);
    const lines = await q<any>(pool, 'SELECT id, product_id FROM order_items WHERE order_id = ?', [o.id]);
    const amountOf = async (pid: number) => Number((await q1<any>(pool, 'SELECT amount_paise FROM commission_entries WHERE order_item_id = ?', [lines.find((l) => l.product_id === pid).id]))!.amount_paise);
    expect(await amountOf(oil.id)).toBe(5000);       // 5% of 1000.00
    expect(await amountOf(rice.id)).toBe(4000);      // 10 units x Rs 4.00
    expect(await amountOf(soap.id)).toBe(3000);      // platform default 3%
  });

  it('with no rule the distributor\'s own rate applies', async () => {
    const s = await outside(); const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    const line = await q1<any>(pool, 'SELECT commission_mode, commission_value, commission_rule_id FROM order_items WHERE order_id = ?', [o.id]);
    expect(line).toMatchObject({ commission_mode: 'percent', commission_value: 200, commission_rule_id: null });
  });

  it('a rule added after the order was placed does not change it', async () => {
    const a = await admin(); const s = await outside(); const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    await request(app).post('/api/v1/admin/commission/rules').set(auth(a.token)).send({ percent: 10, product_id: p.id }).expect(201);
    await deliver(s.d, o.id);
    expect(Number((await entries(o.id))[0].amount_paise)).toBe(2000);    // still the 2% in force when it was placed
    const o2 = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    await deliver(s.d, o2.id);
    expect(Number((await entries(o2.id))[0].amount_paise)).toBe(10000);  // the new order gets the new rule
  });

  it('honours date windows, can be switched off, and validates input', async () => {
    const a = await admin(); const s = await outside(); const p = await s.product();
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const rule = (await request(app).post('/api/v1/admin/commission/rules').set(auth(a.token)).send({ percent: 9, product_id: p.id, valid_from: future }).expect(201)).body;
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 1 }]).expect(201)).body.order;
    expect((await q1<any>(pool, 'SELECT commission_value v FROM order_items WHERE order_id = ?', [o.id]))!.v).toBe(200);   // not started: the distributor's rate

    await request(app).delete(`/api/v1/admin/commission/rules/${rule.id}`).set(auth(a.token)).expect(204);
    const list = (await request(app).get('/api/v1/admin/commission/rules').set(auth(a.token)).expect(200)).body.rules;
    expect(list.find((r: any) => r.id === rule.id)).toMatchObject({ is_active: false, percent: 9 });

    const post = (b: object) => request(app).post('/api/v1/admin/commission/rules').set(auth(a.token)).send(b);
    expect((await post({})).status).toBe(400);                                           // neither percent nor fixed
    expect((await post({ percent: 5, fixed_per_unit: '3' })).status).toBe(400);          // both
    expect((await post({ percent: 80 })).status).toBe(400);
    expect((await post({ fixed_per_unit: '1.234' })).status).toBe(400);
    expect((await post({ percent: 5, product_id: 99999 })).status).toBe(400);
    expect((await request(app).post('/api/v1/admin/commission/rules').set(auth(s.d.token)).send({ percent: 1 })).status).toBe(403);
  });
});

describe('reversal on returns', () => {
  it('takes back commission in proportion to what was returned, once', async () => {
    const s = await outside(); const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    await deliver(s.d, o.id);
    const ret = (await request(app).post('/api/v1/returns').set(auth(s.r.token)).set('Idempotency-Key', 'rv' + ++k).send({ order_id: o.id, reason: 'Damaged', items: [{ product_id: p.id, qty: 4 }] }).expect(201)).body.return.id;
    await request(app).post(`/api/v1/returns/${ret}/resolve`).set(auth(s.d.token)).send({ action: 'approve' }).expect(200);
    await request(app).post(`/api/v1/returns/${ret}/resolve`).set(auth(s.d.token)).send({ action: 'approve' }).expect(409);

    const e = await entries(o.id);
    expect(e.map((x) => [x.kind, Number(x.amount_paise)])).toEqual([['earned', 2000], ['reversal', -800]]);   // 4 of 10 units back: 2% of 400.00
    const net = e.reduce((t, x) => t + Number(x.amount_paise), 0);
    expect(net).toBe(1200);
  });

  it('a rejected return reverses nothing', async () => {
    const s = await outside(); const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 5 }]).expect(201)).body.order;
    await deliver(s.d, o.id);
    const ret = (await request(app).post('/api/v1/returns').set(auth(s.r.token)).set('Idempotency-Key', 'rv' + ++k).send({ order_id: o.id, reason: 'Changed mind', items: [{ product_id: p.id, qty: 2 }] }).expect(201)).body.return.id;
    await request(app).post(`/api/v1/returns/${ret}/resolve`).set(auth(s.d.token)).send({ action: 'reject', note: 'Not covered' }).expect(200);
    expect(await entries(o.id)).toHaveLength(1);
  });
});

describe('settlement batches', () => {
  async function owing() {
    const a = await admin(); const s = await outside(); const p = await s.product();
    const o = (await place(s.r, s.d.id, [{ product_id: p.id, qty: 10 }]).expect(201)).body.order;
    await deliver(s.d, o.id);
    return { a, ...s, orderId: o.id };
  }
  const create = (a: { token: string }, distributorId: number, from = today(), to = today()) =>
    request(app).post('/api/v1/admin/commission/settlements').set(auth(a.token)).send({ distributor_id: distributorId, from, to });

  it('collects the unsettled entries into one batch, once, and moves through approve then paid', async () => {
    const s = await owing();
    const sum = (await request(app).get('/api/v1/admin/commission/summary').set(auth(s.a.token)).expect(200)).body.unsettled.find((x: any) => x.distributor_id === s.d.id);
    expect(sum).toMatchObject({ entries: 1, net: '20.00' });

    const b = (await create(s.a, s.d.id).expect(201)).body;
    expect(b).toMatchObject({ distributor_id: s.d.id, entry_count: 1, amount: '20.00', status: 'draft' });
    expect((await entries(s.orderId))[0].settlement_id).toBe(b.id);

    // the same period again, or an overlapping one, is refused; nothing is claimed twice
    expect((await create(s.a, s.d.id)).body.error.code).toBe('PERIOD_OVERLAPS');
    expect(Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM commission_settlements WHERE distributor_id = ?', [s.d.id]))!.n)).toBe(1);

    // paying a statement nobody approved is refused
    expect((await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/pay`).set(auth(s.a.token)).send({ reference: 'UTR123' })).body.error.code).toBe('BAD_STATE');
    await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/approve`).set(auth(s.a.token)).expect(200);
    expect((await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/approve`).set(auth(s.a.token))).body.error.code).toBe('BAD_STATE');

    // the distributor sees what they owe and where to pay
    const mine = (await request(app).get('/api/v1/commission').set(auth(s.d.token)).expect(200)).body;
    expect(mine).toMatchObject({ payable: '20.00', accruing: { amount: '0.00' } });
    expect(mine.settlements[0]).toMatchObject({ id: b.id, status: 'approved' });

    expect((await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/pay`).set(auth(s.a.token)).send({ reference: 'x' })).status).toBe(400);
    await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/pay`).set(auth(s.a.token)).send({ reference: 'UTR123456' }).expect(200);
    expect((await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/cancel`).set(auth(s.a.token)).send({ note: 'oops' })).body.error.code).toBe('BAD_STATE');
    expect((await request(app).get('/api/v1/commission').set(auth(s.d.token))).body.payable).toBe('0.00');
  });

  it('cancelling a statement frees its entries so they can be settled again', async () => {
    const s = await owing();
    const b = (await create(s.a, s.d.id).expect(201)).body;
    await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/cancel`).set(auth(s.a.token)).send({ note: 'Wrong period' }).expect(200);
    expect((await entries(s.orderId))[0].settlement_id).toBeNull();
    const again = (await create(s.a, s.d.id).expect(201)).body;
    expect(again.id).not.toBe(b.id);
    expect(again.amount).toBe('20.00');
  });

  it('new earnings and reversals after a batch go into the next one', async () => {
    const s = await owing();
    const first = (await create(s.a, s.d.id).expect(201)).body;
    // a return approved later is a new (negative) entry; it is not part of the first batch
    const pid = (await q1<any>(pool, 'SELECT product_id FROM order_items WHERE order_id = ?', [s.orderId]))!.product_id;
    const ret = (await request(app).post('/api/v1/returns').set(auth(s.r.token)).set('Idempotency-Key', 'sb' + ++k).send({ order_id: s.orderId, reason: 'Damaged', items: [{ product_id: pid, qty: 1 }] }).expect(201)).body.return.id;
    await request(app).post(`/api/v1/returns/${ret}/resolve`).set(auth(s.d.token)).send({ action: 'approve' }).expect(200);
    const open = (await request(app).get('/api/v1/admin/commission/entries').query({ distributor_id: s.d.id, settled: '0' }).set(auth(s.a.token)).expect(200)).body.entries;
    expect(open.map((e: any) => [e.kind, e.amount])).toEqual([['reversal', '-2.00']]);
    expect((await request(app).get(`/api/v1/admin/commission/settlements/${first.id}`).set(auth(s.a.token))).body.amount).toBe('20.00');
    // a period whose net is below zero carries forward instead of making a negative invoice
    const r = await request(app).post('/api/v1/admin/commission/settlements').set(auth(s.a.token)).send({ distributor_id: s.d.id, from: '2020-01-01', to: '2030-01-01' });
    expect(r.status).toBe(409);
    expect(['NOTHING_DUE', 'PERIOD_OVERLAPS']).toContain(r.body.error.code);
  });

  it('refuses an empty period without leaving a batch behind', async () => {
    const a = await admin(); const d = await reg('distributor');
    const r = await create(a, d.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOTHING_DUE');
    expect(await q(pool, 'SELECT id FROM commission_settlements WHERE distributor_id = ?', [d.id])).toHaveLength(0);
  });

  it('with dual control on, a different admin must confirm the payment', async () => {
    const s = await owing(); const other = await admin();
    await request(app).put('/api/v1/admin/commission/settings').set(auth(s.a.token)).send({ settlement_dual_control: true }).expect(200);
    try {
      const b = (await create(s.a, s.d.id).expect(201)).body;
      await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/approve`).set(auth(s.a.token)).expect(200);
      const same = await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/pay`).set(auth(s.a.token)).send({ reference: 'UTR777' });
      expect(same.status).toBe(403);
      expect(same.body.error.code).toBe('DUAL_CONTROL');
      await request(app).post(`/api/v1/admin/commission/settlements/${b.id}/pay`).set(auth(other.token)).send({ reference: 'UTR777' }).expect(200);
    } finally {
      await request(app).put('/api/v1/admin/commission/settings').set(auth(s.a.token)).send({ settlement_dual_control: false }).expect(200);
    }
  });

  it('is for the admin; a distributor sees only their own figures', async () => {
    const s = await owing(); const other = await reg('distributor');
    expect((await request(app).get('/api/v1/admin/commission/summary').set(auth(s.d.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/commission').set(auth(s.r.token))).status).toBe(403);
    const theirs = (await request(app).get('/api/v1/commission').set(auth(other.token)).expect(200)).body;
    expect(theirs.accruing.amount).toBe('0.00');
    expect(theirs.recent_entries).toEqual([]);
  });
});
