import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q, q1 } from '../src/db/pool';
import { razorpay, setGateway } from '../src/services/gateway';
import { makeCategory, onboardDistributor, payAndConfirm, startOnboarding } from './helpers/onboard';

const app = createApp();
let n = 0;
const phone = () => String(5100000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SECRET = 'whsec_ob';
const DAY = 86400000;

let fakeApi: http.Server; let fakeUrl = '';
beforeAll(async () => {
  await migrate(true);
  fakeApi = http.createServer((req, res) => { req.resume(); req.on('end', () => { const id = 'plink_' + crypto.randomBytes(5).toString('hex'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id, short_url: `https://pay.test/${id}` })); }); });
  await new Promise<void>((ok) => fakeApi.listen(0, '127.0.0.1', ok));
  fakeUrl = `http://127.0.0.1:${(fakeApi.address() as any).port}`;
});
afterEach(() => setGateway(undefined));
afterAll(async () => { fakeApi.close(); await pool.end(); });

async function admin() {
  const p = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return { token: (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string };
}
async function employee(a: { token: string }, over: object = {}) {
  const p = phone();
  const s = (await request(app).post('/api/v1/admin/staff').set(auth(a.token)).send({
    phone: p, name: 'Emp ' + n, password: 'password123', actions: ['create_distributors', 'manage_distributors'], grantable: ['chat_enabled', 'online_payments', 'cod_enabled'], ...over,
  }).expect(201)).body;
  const token = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
  return { id: s.id as number, token };
}
const loginStatus = (p: string, password = 'password123') => request(app).post('/api/v1/auth/login').send({ phone: p, password }).then((r) => r.status);
const hook = (payload: object, eventId = 'evt_' + crypto.randomBytes(4).toString('hex')) => {
  const raw = JSON.stringify(payload);
  return request(app).post('/api/v1/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-event-id', eventId)
    .set('x-razorpay-signature', crypto.createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw);
};
const paid = (linkId: string, amountPaise: number) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: linkId, reference_id: 'ob_x', amount: amountPaise } }, payment: { entity: { id: 'pay_' + linkId.slice(-6), amount: amountPaise } } } });
const gwOn = () => setGateway(razorpay({ keyId: 'k', keySecret: 's', webhookSecret: SECRET, baseUrl: fakeUrl }));

describe('a distributor exists only once the subscription fee has arrived', () => {
  it('nothing is created when onboarding starts; the account appears, with its timer, when the UPI payment is confirmed', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e);
    expect(s.res.status).toBe(201);
    const r = s.res.body.request;
    expect(r).toMatchObject({ status: 'awaiting_payment', method: 'upi', plan_name: 'Monthly', days: 30, amount: '999.00', business_name: s.body.business_name });
    expect(r.pay_to).toMatchObject({ upi_id: 'aayme@okaxis', payee: 'AAYME' });
    expect(r.pay_to.uri).toContain('am=999.00');

    expect(await loginStatus(s.phone)).toBe(401);                                          // no account yet
    expect(await q1(pool, 'SELECT id FROM users WHERE phone = ?', [s.phone])).toBeUndefined();

    await request(app).post(`/api/v1/staff/onboarding/${r.id}/utr`).set(auth(e.token)).send({ utr: 'UTR12345678' }).expect(200);
    expect(await loginStatus(s.phone)).toBe(401);                                          // a reported UTR is not money received

    const before = Date.now();
    const done = await request(app).post(`/api/v1/admin/onboarding/${r.id}/confirm`).set(auth(a.token)).expect(200);
    const after = Date.now();
    expect(await loginStatus(s.phone)).toBe(200);

    // the timer starts at the moment of confirmation: 30 days from then
    const d = await q1<any>(pool, 'SELECT subscription_ends_at e, plan_name, review_required FROM distributor_profiles WHERE user_id = ?', [done.body.distributor_id]);
    const ends = +new Date(d!.e);
    expect(ends).toBeGreaterThanOrEqual(before + 30 * DAY - 2000);
    expect(ends).toBeLessThanOrEqual(after + 30 * DAY + 2000);
    expect(d!.plan_name).toBe('Monthly');
    expect(await q1<any>(pool, 'SELECT created_by FROM users WHERE id = ?', [done.body.distributor_id])).toMatchObject({ created_by: e.id });
    expect((await q<any>(pool, 'SELECT category_id FROM distributor_categories WHERE distributor_id = ?', [done.body.distributor_id])).map((x) => x.category_id)).toEqual([s.category!.id]);

    // the fee is on record like any subscription payment, and the distributor sees an active plan
    const pay = await q1<any>(pool, "SELECT status, amount_paise, utr FROM subscription_payments WHERE distributor_id = ?", [done.body.distributor_id]);
    expect(pay).toMatchObject({ status: 'confirmed', utr: 'UTR12345678' });
    expect(Number(pay!.amount_paise)).toBe(99900);
    const dTok = (await request(app).post('/api/v1/auth/login').send({ phone: s.phone, password: 'password123' })).body.access_token;
    expect((await request(app).get('/api/v1/subscription').set(auth(dTok)).expect(200)).body).toMatchObject({ plan_name: 'Monthly', status: 'active' });

    // confirming again changes nothing
    const again = await request(app).post(`/api/v1/admin/onboarding/${r.id}/confirm`).set(auth(a.token)).expect(200);
    expect(again.body).toMatchObject({ replayed: true, distributor_id: done.body.distributor_id });
    expect(Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM users WHERE phone = ?', [s.phone]))!.n)).toBe(1);
  });

  it('the fee counts as platform revenue', async () => {
    const a = await admin(); const e = await employee(a);
    const d = await onboardDistributor(app, a, e);
    const k = (await request(app).get('/api/v1/admin/analytics').query({ distributor_id: d.id }).set(auth(a.token)).expect(200)).body.kpis;
    expect(k.platform_revenue_parts.subscriptions).toBe('999.00');
  });

  it('confirming before a UTR was entered is refused', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e);
    expect((await request(app).post(`/api/v1/admin/onboarding/${s.res.body.request.id}/confirm`).set(auth(a.token))).body.error.code).toBe('NOT_SUBMITTED');
  });

  it('rejecting a UPI payment that was not found creates nothing and tells the employee why', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e);
    const id = s.res.body.request.id;
    await request(app).post(`/api/v1/staff/onboarding/${id}/utr`).set(auth(e.token)).send({ utr: 'FAKEUTR9999' }).expect(200);
    await request(app).post(`/api/v1/admin/onboarding/${id}/reject`).set(auth(a.token)).send({ note: 'No such credit in the bank statement' }).expect(200);
    expect(await loginStatus(s.phone)).toBe(401);
    const row = (await request(app).get(`/api/v1/staff/onboarding/${id}`).set(auth(e.token)).expect(200)).body.request;
    expect(row).toMatchObject({ status: 'failed', error: 'No such credit in the bank statement' });
    expect((await request(app).post(`/api/v1/admin/onboarding/${id}/confirm`).set(auth(a.token))).status).toBe(409);
  });

  it('a UTR can be used once', async () => {
    const a = await admin(); const e = await employee(a);
    const one = await startOnboarding(app, a, e); const two = await startOnboarding(app, a, e);
    await request(app).post(`/api/v1/staff/onboarding/${one.res.body.request.id}/utr`).set(auth(e.token)).send({ utr: 'SAMEUTR12345' }).expect(200);
    expect((await request(app).post(`/api/v1/staff/onboarding/${two.res.body.request.id}/utr`).set(auth(e.token)).send({ utr: 'sameutr12345' })).body.error.code).toBe('UTR_USED');
  });
});

describe('paying through a payment link', () => {
  it('creates the account by itself when the gateway confirms the exact amount, and ignores a retry', async () => {
    const a = await admin(); const e = await employee(a);
    gwOn();
    const s = await startOnboarding(app, a, e, { method: 'gateway' });
    expect(s.res.status).toBe(201);
    expect(s.res.body.checkout_url).toMatch(/^https:\/\/pay\.test\/plink_/);
    expect(s.res.body.request.pay_to).toBeNull();
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM onboarding_requests WHERE id = ?', [s.res.body.request.id]))!.gateway_ref;
    expect(await loginStatus(s.phone)).toBe(401);

    expect((await hook(paid(ref, 99900)).expect(200)).body.result).toBe('onboarding_completed');
    expect(await loginStatus(s.phone)).toBe(200);
    expect((await hook(paid(ref, 99900), 'retry-event').expect(200)).body.result).toBe('already_settled');
    expect(Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM users WHERE phone = ?', [s.phone]))!.n)).toBe(1);
    expect((await request(app).get(`/api/v1/staff/onboarding/${s.res.body.request.id}`).set(auth(e.token))).body.request.status).toBe('completed');
  });

  it('a payment of the wrong amount does not create the account', async () => {
    const a = await admin(); const e = await employee(a);
    gwOn();
    const s = await startOnboarding(app, a, e, { method: 'gateway' });
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM onboarding_requests WHERE id = ?', [s.res.body.request.id]))!.gateway_ref;
    expect((await hook(paid(ref, 50000)).expect(200)).body.result).toBe('amount_mismatch');
    expect(await loginStatus(s.phone)).toBe(401);
    const row = (await request(app).get(`/api/v1/staff/onboarding/${s.res.body.request.id}`).set(auth(e.token))).body.request;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/500.00 but 999.00 was due/);
  });

  it('an expired link fails the request; a signature is required', async () => {
    const a = await admin(); const e = await employee(a);
    gwOn();
    const s = await startOnboarding(app, a, e, { method: 'gateway' });
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM onboarding_requests WHERE id = ?', [s.res.body.request.id]))!.gateway_ref;
    expect((await request(app).post('/api/v1/payments/webhook').set('x-razorpay-signature', 'bad').send(paid(ref, 99900))).status).toBe(401);
    expect(await loginStatus(s.phone)).toBe(401);
    await hook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: ref, reference_id: 'ob_x' } } } }).expect(200);
    expect((await request(app).get(`/api/v1/staff/onboarding/${s.res.body.request.id}`).set(auth(e.token))).body.request.status).toBe('failed');
  });

  it('a gateway request cannot be confirmed by hand, and cannot be cancelled', async () => {
    const a = await admin(); const e = await employee(a);
    gwOn();
    const s = await startOnboarding(app, a, e, { method: 'gateway' });
    const id = s.res.body.request.id;
    expect((await request(app).post(`/api/v1/admin/onboarding/${id}/confirm`).set(auth(a.token))).body.error.code).toBe('GATEWAY_REQUEST');
    expect((await request(app).post(`/api/v1/staff/onboarding/${id}/cancel`).set(auth(e.token))).body.error.code).toBe('CANNOT_CANCEL');
    expect((await request(app).post(`/api/v1/staff/onboarding/${id}/utr`).set(auth(e.token)).send({ utr: 'UTR123456789' })).body.error.code).toBe('NOT_UPI');
  });

  it('without a configured gateway the link option is refused', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e, { method: 'gateway' });
    expect(s.res.status).toBe(501);
  });
});

describe('when the details clash', () => {
  it('the phone cannot be one that is registered, or one already being onboarded', async () => {
    const a = await admin(); const e = await employee(a);
    const first = await startOnboarding(app, a, e);
    expect(first.res.status).toBe(201);
    expect((await startOnboarding(app, a, e, { phone: first.phone, category_ids: [first.category!.id] })).res.body.error.code).toBe('ONBOARDING_EXISTS');
    const existing = (await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: phone(), email: `r${n}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop', pincode: '400001' }).expect(201)).body;
    const taken = (await q1<any>(pool, 'SELECT phone FROM users WHERE id = ?', [existing.id]))!.phone;
    expect((await startOnboarding(app, a, e, { phone: taken, category_ids: [first.category!.id] })).res.body.error.code).toBe('PHONE_TAKEN');
  });

  it('if the phone is registered while the payment is on its way, no clashing account is made and the money is flagged', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e);
    const id = s.res.body.request.id;
    await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: s.phone, email: `late${n}@t.local`, name: 'Late', password: 'password123', shop_name: 'Late Shop', pincode: '400001' }).expect(201);
    const done = await payAndConfirm(app, a, e, id);
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('NEEDS_ATTENTION');
    const row = (await request(app).get(`/api/v1/staff/onboarding/${id}`).set(auth(e.token))).body.request;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/refund/i);
    expect((await q1<any>(pool, 'SELECT role FROM users WHERE phone = ?', [s.phone]))!.role).toBe('retailer');
  });

  it('replaying the same request returns the same onboarding instead of a second one', async () => {
    const a = await admin(); const e = await employee(a);
    const cat = await makeCategory(app, a.token);
    const body = { business_name: 'Replay Traders', name: 'Owner', phone: phone(), password: 'password123', plan_id: 1, method: 'upi', category_ids: [cat.id] };
    await request(app).put('/api/v1/admin/settings').set(auth(a.token)).send({ company_upi_id: 'aayme@okaxis' }).expect(200);
    const one = await request(app).post('/api/v1/staff/onboarding').set(auth(e.token)).set('Idempotency-Key', 'same-key').send(body).expect(201);
    const two = await request(app).post('/api/v1/staff/onboarding').set(auth(e.token)).set('Idempotency-Key', 'same-key').send(body).expect(200);
    expect(two.body).toMatchObject({ replayed: true });
    expect(two.body.request.id).toBe(one.body.request.id);
    expect((await request(app).post('/api/v1/staff/onboarding').set(auth(e.token)).send(body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('what the employee must provide and may give', () => {
  it('needs a category, a real plan, and a valid UPI id set up by the admin', async () => {
    const a = await admin(); const e = await employee(a);
    const cat = await makeCategory(app, a.token);
    const post = (b: object) => request(app).post('/api/v1/staff/onboarding').set(auth(e.token)).set('Idempotency-Key', 'v-' + ++n).send({ business_name: 'Valid Co', name: 'Owner', phone: phone(), password: 'password123', plan_id: 1, method: 'upi', category_ids: [cat.id], ...b });
    await request(app).put('/api/v1/admin/settings').set(auth(a.token)).send({ company_upi_id: 'aayme@okaxis' }).expect(200);
    expect((await post({ category_ids: [] })).status).toBe(400);
    expect((await post({ category_ids: undefined })).status).toBe(400);
    expect((await post({ category_ids: [999999] })).body.error.code).toBe('BAD_CATEGORY');
    expect((await post({ plan_id: 999999 })).status).toBe(404);
    expect((await post({ password: 'short' })).status).toBe(400);
    expect((await post({ phone: '123' })).status).toBe(400);
    expect((await post({ gst_no: 'BAD' })).status).toBe(400);
    expect((await post({})).status).toBe(201);
  });

  it('can only give the switches the admin allowed (cash on delivery and online payment among them)', async () => {
    const a = await admin();
    const full = await employee(a);                                                                       // may grant chat, online payments, COD
    const limited = await employee(a, { grantable: ['chat_enabled'] });
    const withCod = await onboardDistributor(app, a, full, { permissions: { cod_enabled: true, online_payments: true } });
    expect((await request(app).get('/api/v1/distributor/me').set(auth(withCod.token)).expect(200)).body.permissions).toMatchObject({ cod_enabled: true, online_payments: true });
    const bare = await onboardDistributor(app, a, full);
    expect((await request(app).get('/api/v1/distributor/me').set(auth(bare.token)).expect(200)).body.permissions).toMatchObject({ cod_enabled: false, online_payments: true });   // what the employee may grant starts on, except COD
    expect((await startOnboarding(app, a, limited, { permissions: { cod_enabled: true } })).res.status).toBe(403);
    expect((await startOnboarding(app, a, limited, { permissions: { online_payments: true } })).res.status).toBe(403);
  });

  it('a UPI request can be cancelled before it is paid, not after', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e);
    const id = s.res.body.request.id;
    await request(app).post(`/api/v1/staff/onboarding/${id}/cancel`).set(auth(e.token)).expect(200);
    expect((await request(app).post(`/api/v1/staff/onboarding/${id}/utr`).set(auth(e.token)).send({ utr: 'UTR987654321' })).status).toBe(409);
    const s2 = await startOnboarding(app, a, e);
    await request(app).post(`/api/v1/staff/onboarding/${s2.res.body.request.id}/utr`).set(auth(e.token)).send({ utr: 'UTR555555555' }).expect(200);
    expect((await request(app).post(`/api/v1/staff/onboarding/${s2.res.body.request.id}/cancel`).set(auth(e.token))).body.error.code).toBe('CANNOT_CANCEL');
  });

  it('employees see only their own onboardings; the admin sees the queue', async () => {
    const a = await admin(); const e1 = await employee(a); const e2 = await employee(a);
    const s = await startOnboarding(app, a, e1);
    await request(app).post(`/api/v1/staff/onboarding/${s.res.body.request.id}/utr`).set(auth(e1.token)).send({ utr: 'UTRQUEUE1234' }).expect(200);
    expect((await request(app).get(`/api/v1/staff/onboarding/${s.res.body.request.id}`).set(auth(e2.token))).status).toBe(404);
    expect((await request(app).get('/api/v1/staff/onboarding').set(auth(e2.token)).expect(200)).body.requests).toEqual([]);
    const queue = (await request(app).get('/api/v1/admin/onboarding').query({ status: 'payment_submitted' }).set(auth(a.token)).expect(200)).body.requests;
    expect(queue.find((r: any) => r.id === s.res.body.request.id)).toMatchObject({ utr: 'UTRQUEUE1234', created_by: e1.id });
    // the request never exposes the distributor's password
    expect(JSON.stringify(queue)).not.toMatch(/password|hash/i);
  });

  it('only the admin confirms payments; the employee who started it cannot', async () => {
    const a = await admin(); const e = await employee(a);
    const s = await startOnboarding(app, a, e);
    await request(app).post(`/api/v1/staff/onboarding/${s.res.body.request.id}/utr`).set(auth(e.token)).send({ utr: 'UTRSELF12345' }).expect(200);
    expect((await request(app).post(`/api/v1/admin/onboarding/${s.res.body.request.id}/confirm`).set(auth(e.token))).status).toBe(403);
    expect(await loginStatus(s.phone)).toBe(401);
  });
});

describe('mapping a distributor to an employee', () => {
  it('the admin can hand a distributor to another company employee', async () => {
    const a = await admin(); const e1 = await employee(a); const e2 = await employee(a);
    const d = await onboardDistributor(app, a, e1);
    expect((await request(app).get('/api/v1/staff/distributors').set(auth(e2.token))).body.distributors).toEqual([]);
    await request(app).put(`/api/v1/admin/distributors/${d.id}/employee`).set(auth(a.token)).send({ employee_id: e2.id }).expect(200);
    expect((await request(app).get('/api/v1/staff/distributors').set(auth(e2.token))).body.distributors.map((x: any) => x.id)).toEqual([d.id]);
    expect((await request(app).get('/api/v1/staff/distributors').set(auth(e1.token))).body.distributors).toEqual([]);
    expect((await request(app).put(`/api/v1/admin/distributors/${d.id}/employee`).set(auth(a.token)).send({ employee_id: d.id })).body.error.code).toBe('NOT_AN_EMPLOYEE');
    expect((await request(app).put(`/api/v1/admin/distributors/${d.id}/employee`).set(auth(e1.token)).send({ employee_id: e2.id })).status).toBe(403);
  });
});
