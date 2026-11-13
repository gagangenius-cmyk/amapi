import request from 'supertest';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(9100000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (p: string, password = 'password123') => (await request(app).post('/api/v1/auth/login').send({ phone: p, password }).expect(200)).body.access_token as string;

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return login(p);
}
async function distributor() {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@c.test`, name: 'Owner', password: 'password123', business_name: 'Seller ' + p }).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string };
}
const mkPlan = async (a: string, over: object = {}) => (await request(app).post('/api/v1/admin/retailer-plans').set(auth(a))
  .send({ name: 'Plan ' + ++n, days: 30, price: '999', commission_new: 20, commission_renewal: 10, commission_upgrade: 5, ...over }).expect(201)).body;
const newRetailer = (n2 = phone()) => ({ name: 'Shop Owner', phone: n2, shop_name: 'Shop ' + n2, pincode: '400001', password: 'password123' });
const sell = (d: { token: string }, body: object) => request(app).post('/api/v1/sales/sell').set(auth(d.token)).send(body);
const confirm = (a: string, id: number) => request(app).post(`/api/v1/admin/subscription-sales/${id}/confirm`).set(auth(a));

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('plans', () => {
  it('are managed by the admin only, and distributors see what they would earn on each', async () => {
    const a = await admin(); const d = await distributor();
    const plan = await mkPlan(a, { name: 'Basic X', price: '999', features: ['Online store', 'Own products'] });
    expect(plan).toMatchObject({ name: 'Basic X', price: '999.00', days: 30, commission: { new: 20, renewal: 10, upgrade: 5 }, features: ['Online store', 'Own products'] });
    expect((await request(app).post('/api/v1/admin/retailer-plans').set(auth(d.token)).send({ name: 'Nope', days: 30, price: '1' })).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/retailer-plans').set(auth(a)).send({ name: 'Free', days: 30, price: '0' })).status).toBe(400);

    const mine = (await request(app).get('/api/v1/sales/plans').set(auth(d.token)).expect(200)).body;
    const p = mine.plans.find((x: any) => x.id === plan.id);
    expect(p.my_commission).toEqual({ new: 20, renewal: 10, upgrade: 5 });
    expect(mine.switches).toEqual({ new: true, renewal: true, upgrade: true });

    await request(app).put(`/api/v1/admin/retailer-plans/${plan.id}`).set(auth(a)).send({ price: '1099', is_active: false }).expect(200);
    expect((await request(app).get('/api/v1/sales/plans').set(auth(d.token))).body.plans.some((x: any) => x.id === plan.id)).toBe(false);   // switched off: not offered
  });
});

describe('selling a subscription', () => {
  it('creates the retailer, waits for the admin to confirm the payment, then activates the plan and credits the commission', async () => {
    const a = await admin(); const d = await distributor(); const plan = await mkPlan(a);
    const r = newRetailer();
    const sale = (await sell(d, { plan_id: plan.id, retailer: r, method: 'upi', reference: 'UTR123456' }).expect(201)).body;
    expect(sale).toMatchObject({ kind: 'new', amount: '999.00', status: 'payment_submitted', retailer_created: true });
    expect(sale.upi_link === null || sale.upi_link.startsWith('upi://pay')).toBe(true);
    await login(r.phone);                                                   // the new retailer can sign in

    const retTok = await login(r.phone);
    expect((await request(app).get('/api/v1/retailer/subscription').set(auth(retTok)).expect(200)).body.active).toBe(false);   // not before payment is confirmed

    const queue = (await request(app).get('/api/v1/admin/subscription-sales').set(auth(a)).expect(200)).body.sales;
    expect(queue.find((x: any) => x.id === sale.id)).toMatchObject({ status: 'payment_submitted', reference: 'UTR123456', commission_percent: 20 });

    expect((await confirm(a, sale.id).expect(200)).body).toMatchObject({ status: 'paid', replayed: false });
    expect((await confirm(a, sale.id).expect(200)).body.replayed).toBe(true);        // safe to press twice

    const sub = (await request(app).get('/api/v1/retailer/subscription').set(auth(retTok)).expect(200)).body;
    expect(sub.active).toBe(true);
    expect(sub.current.plan_name).toBe(plan.name);
    expect(sub.current.days_left).toBeGreaterThanOrEqual(29);

    const earn = (await request(app).get('/api/v1/sales/earnings').set(auth(d.token)).expect(200)).body;
    expect(earn).toMatchObject({ pending: '199.80', settled: '0.00', paid_sales: 1, sales_value: '999.00' });
  });

  it('knows a renewal from a new sale, and a better plan from a renewal (paying only the difference)', async () => {
    const a = await admin(); const d = await distributor();
    const basic = await mkPlan(a, { price: '1000' }); const premium = await mkPlan(a, { price: '3000', days: 90, commission_new: 25, commission_upgrade: 5 });
    const r = newRetailer(); let retailerId = 0;

    const s1 = (await sell(d, { plan_id: basic.id, retailer: r, method: 'cash' }).expect(201)).body; retailerId = s1.retailer_id;
    await confirm(a, s1.id).expect(200);

    const s2 = (await sell(d, { plan_id: basic.id, retailer_id: retailerId, method: 'cash' }).expect(201)).body;
    expect(s2).toMatchObject({ kind: 'renewal', amount: '1000.00' });
    await confirm(a, s2.id).expect(200);
    const retTok = await login(r.phone);
    expect((await request(app).get('/api/v1/retailer/subscription').set(auth(retTok))).body.current.days_left).toBeGreaterThanOrEqual(59);   // 30 + 30: paying early wastes nothing

    const s3 = (await sell(d, { plan_id: premium.id, retailer_id: retailerId, method: 'cash' }).expect(201)).body;
    expect(s3).toMatchObject({ kind: 'upgrade', amount: '2000.00' });                 // 3000 - 1000
    await confirm(a, s3.id).expect(200);
    expect((await request(app).get('/api/v1/retailer/subscription').set(auth(retTok))).body.current.plan_name).toBe(premium.name);

    const earn = (await request(app).get('/api/v1/sales/earnings').set(auth(d.token))).body;
    // new 20% of 1000 = 200, renewal 10% of 1000 = 100, upgrade 5% of 2000 = 100
    expect(earn.pending).toBe('400.00');
    expect(earn.by_kind.map((k: any) => k.kind).sort()).toEqual(['new', 'renewal', 'upgrade']);
  });

  it('refuses a second open sale for the same retailer, a missing reference, and a retailer that is not theirs', async () => {
    const a = await admin(); const d = await distributor(); const other = await distributor(); const plan = await mkPlan(a);
    const r = newRetailer();
    const first = (await sell(d, { plan_id: plan.id, retailer: r }).expect(201)).body;
    expect(first.status).toBe('awaiting_payment');
    expect((await sell(d, { plan_id: plan.id, retailer_id: first.retailer_id })).body.error.code).toBe('SALE_OPEN');
    expect((await sell(d, { plan_id: plan.id, retailer: newRetailer(), method: 'upi' })).body.error.code).toBe('REFERENCE_REQUIRED');
    expect((await sell(other, { plan_id: plan.id, retailer_id: first.retailer_id })).body.error.code).toBe('RETAILER_NOT_FOUND');
    // the reference can come later
    const paid = (await request(app).post(`/api/v1/sales/${first.id}/payment`).set(auth(d.token)).send({ method: 'upi', reference: 'UTR999999' }).expect(200)).body;
    expect(paid.status).toBe('payment_submitted');
  });

  it('a sale that is rejected can be sent again; a cancelled one is closed', async () => {
    const a = await admin(); const d = await distributor(); const plan = await mkPlan(a);
    const s = (await sell(d, { plan_id: plan.id, retailer: newRetailer(), method: 'upi', reference: 'WRONG0001' }).expect(201)).body;
    await request(app).post(`/api/v1/admin/subscription-sales/${s.id}/reject`).set(auth(a)).send({ note: 'No such payment' }).expect(200);
    expect((await q1<any>(pool, 'SELECT status, decision_note FROM subscription_sales WHERE id = ?', [s.id]))).toMatchObject({ status: 'rejected', decision_note: 'No such payment' });
    await request(app).post(`/api/v1/sales/${s.id}/payment`).set(auth(d.token)).send({ method: 'upi', reference: 'RIGHT00002' }).expect(200);
    await confirm(a, s.id).expect(200);
    expect((await request(app).post(`/api/v1/sales/${s.id}/cancel`).set(auth(d.token))).status).toBe(409);   // already paid
  });
});

describe('commission rules', () => {
  it('uses the distributor’s own rate when the admin sets one, and none for a kind that is switched off', async () => {
    const a = await admin(); const d = await distributor(); const plan = await mkPlan(a);
    await request(app).put(`/api/v1/admin/distributors/${d.id}/commission-rates`).set(auth(a)).send({ plan_id: null, new: 30 }).expect(200);          // all plans: 30% on new
    await request(app).put(`/api/v1/admin/distributors/${d.id}/commission-rates`).set(auth(a)).send({ plan_id: plan.id, new: 35, renewal: 15 }).expect(200);   // this plan: more
    const mine = (await request(app).get('/api/v1/sales/plans').set(auth(d.token))).body.plans.find((x: any) => x.id === plan.id);
    expect(mine.my_commission).toEqual({ new: 35, renewal: 15, upgrade: 5 });                       // upgrade falls through to the plan default

    const s = (await sell(d, { plan_id: plan.id, retailer: newRetailer(), method: 'cash' }).expect(201)).body;
    await confirm(a, s.id).expect(200);
    expect((await request(app).get('/api/v1/sales/earnings').set(auth(d.token))).body.pending).toBe('349.65');   // 35% of 999

    await request(app).put('/api/v1/admin/retailer-sales/settings').set(auth(a)).send({ renewal: false }).expect(200);
    const s2 = (await sell(d, { plan_id: plan.id, retailer_id: s.retailer_id, method: 'cash' }).expect(201)).body;
    expect(s2.kind).toBe('renewal');
    await confirm(a, s2.id).expect(200);
    expect((await request(app).get('/api/v1/sales/earnings').set(auth(d.token))).body.pending).toBe('349.65');   // the renewal earned nothing
    await request(app).put('/api/v1/admin/retailer-sales/settings').set(auth(a)).send({ renewal: true }).expect(200);
  });
});

describe('refunds and payouts', () => {
  it('a refund ends the subscription and takes the commission back; an upgrade refund returns to the old plan', async () => {
    const a = await admin(); const d = await distributor();
    const basic = await mkPlan(a, { price: '1000' }); const premium = await mkPlan(a, { price: '3000' });
    const s1 = (await sell(d, { plan_id: basic.id, retailer: newRetailer(), method: 'cash' }).expect(201)).body;
    await confirm(a, s1.id).expect(200);
    const s2 = (await sell(d, { plan_id: premium.id, retailer_id: s1.retailer_id, method: 'cash' }).expect(201)).body;
    await confirm(a, s2.id).expect(200);
    const ret = (await q1<any>(pool, 'SELECT u.phone FROM users u WHERE u.id = ?', [s1.retailer_id]))!;
    const retTok = await login(ret.phone);

    await request(app).post(`/api/v1/admin/subscription-sales/${s2.id}/refund`).set(auth(a)).send({ note: 'Changed mind' }).expect(200);
    expect((await request(app).get('/api/v1/retailer/subscription').set(auth(retTok))).body.current.plan_name).toBe(basic.name);   // back on the plan they had
    await request(app).post(`/api/v1/admin/subscription-sales/${s1.id}/refund`).set(auth(a)).send({}).expect(200);
    expect((await request(app).get('/api/v1/retailer/subscription').set(auth(retTok))).body.active).toBe(false);
    const earn = (await request(app).get('/api/v1/sales/earnings').set(auth(d.token))).body;
    expect(earn).toMatchObject({ pending: '0.00', settled: '0.00', to_recover: '0.00' });
    expect((await request(app).post(`/api/v1/admin/subscription-sales/${s1.id}/refund`).set(auth(a)).send({})).status).toBe(409);       // only once
  });

  it('pays out accrued commission, and flags a later refund for recovery', async () => {
    const a = await admin(); const d = await distributor(); const plan = await mkPlan(a, { price: '1000', commission_new: 10 });
    const s = (await sell(d, { plan_id: plan.id, retailer: newRetailer(), method: 'cash' }).expect(201)).body;
    await confirm(a, s.id).expect(200);
    expect((await request(app).post('/api/v1/admin/subscription-sales/payouts').set(auth(a)).send({ distributor_id: d.id, reference: 'NEFT-778899' }).expect(200)).body).toMatchObject({ paid: '100.00', sales: 1 });
    expect((await request(app).get('/api/v1/sales/earnings').set(auth(d.token))).body).toMatchObject({ pending: '0.00', settled: '100.00' });
    expect((await request(app).post('/api/v1/admin/subscription-sales/payouts').set(auth(a)).send({ distributor_id: d.id, reference: 'AGAIN' })).status).toBe(409);   // nothing left to pay

    await request(app).post(`/api/v1/admin/subscription-sales/${s.id}/refund`).set(auth(a)).send({}).expect(200);
    const earn = (await request(app).get('/api/v1/sales/earnings').set(auth(d.token))).body;
    expect(earn).toMatchObject({ settled: '0.00', to_recover: '100.00' });                 // already paid out: to be recovered
  });
});

describe('leads, performance and reports', () => {
  it('keeps leads, shows progress against the target, and reports sales distributor by distributor', async () => {
    const a = await admin(); const d = await distributor(); const plan = await mkPlan(a, { price: '2000' });
    const lead = (await request(app).post('/api/v1/sales/leads').set(auth(d.token)).send({ name: 'Prospect One', phone: phone(), shop_name: 'Prospect Store' }).expect(201)).body;
    expect(lead.status).toBe('new');
    const up = await request(app).put(`/api/v1/sales/leads/${lead.id}`).set(auth(d.token)).send({ status: 'contacted', note: 'Call tomorrow' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const list = (await request(app).get('/api/v1/sales/leads').set(auth(d.token)).expect(200)).body;
    expect(list.leads).toHaveLength(1); expect(list.counts).toEqual({ contacted: 1 });

    const month = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const tg = await request(app).put(`/api/v1/admin/distributors/${d.id}/targets`).set(auth(a)).send({ month, target_amount: '4000', target_count: 4 });
    expect(tg.status, JSON.stringify(tg.body)).toBe(200);
    const s = (await sell(d, { plan_id: plan.id, retailer: newRetailer(), method: 'cash', lead_id: lead.id }).expect(201)).body;
    await confirm(a, s.id).expect(200);
    expect((await request(app).get('/api/v1/sales/leads').set(auth(d.token))).body.counts).toEqual({ converted: 1 });   // the lead converts when the sale is paid

    const perf = (await request(app).get('/api/v1/sales/performance').set(auth(d.token)).expect(200)).body;
    expect(perf.this_month).toMatchObject({ month, sales: 1, amount: '2000.00', target_amount: '4000.00', target_count: 4, amount_progress: 50, count_progress: 25 });
    expect(perf.leads).toMatchObject({ total: 1, converted: 1, conversion_percent: 100 });

    const rep = (await request(app).get('/api/v1/admin/retailer-sales/report').set(auth(a)).expect(200)).body.distributors;
    expect(rep.find((x: any) => x.distributor_id === d.id)).toMatchObject({ paid_sales: 1, amount: '2000.00', new: 1, renewal: 0, refunded: 0 });
    const hist = (await request(app).get('/api/v1/sales/history').set(auth(d.token)).expect(200)).body.sales;
    expect(hist).toHaveLength(1); expect(hist[0]).toMatchObject({ status: 'paid', kind: 'new' });

    const subs = (await request(app).get('/api/v1/admin/retailer-subscriptions').query({ state: 'active' }).set(auth(a)).expect(200)).body.subscriptions;
    expect(subs.some((x: any) => x.retailer_id === s.retailer_id && x.active)).toBe(true);
  });

  it('keeps the selling tools away from retailers and other roles', async () => {
    const a = await admin(); const p = phone();
    const r = await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `r${p}@c.test`, name: 'Retailer', password: 'password123', shop_name: 'S ' + p, pincode: '400001' }).expect(201);
    expect((await request(app).get('/api/v1/sales/plans').set(auth(r.body.access_token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/subscription-sales').set(auth(r.body.access_token))).status).toBe(403);
    expect((await request(app).get('/api/v1/sales/plans')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/retailer-plans').set(auth(a))).status).toBe(200);
  });
});
