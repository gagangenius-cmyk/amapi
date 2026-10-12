import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q, q1 } from '../src/db/pool';
import { runExpiryWarnings } from '../src/jobs/subscriptionWarnings';
import { razorpay, setGateway } from '../src/services/gateway';
import { setPushTransport, Transport } from '../src/services/notify';

const app = createApp();
let n = 0;
const phone = () => String(6900000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const day = 86400000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'whsec_sub';

let admin = ''; let fakeApi: http.Server; let fakeUrl = '';
const pushes: string[] = [];
beforeAll(async () => {
  await migrate(true);
  const ap = phone();
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [ap, 'Root', await bcrypt.hash('password123', 4)]);
  admin = (await request(app).post('/api/v1/auth/login').send({ phone: ap, password: 'password123' })).body.access_token;
  fakeApi = http.createServer((req, res) => { req.resume(); req.on('end', () => { const id = 'plink_' + crypto.randomBytes(5).toString('hex'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id, short_url: `https://pay.test/${id}` })); }); });
  await new Promise<void>((ok) => fakeApi.listen(0, '127.0.0.1', ok));
  fakeUrl = `http://127.0.0.1:${(fakeApi.address() as any).port}`;
  const t: Transport = { async send(m) { m.forEach((x) => pushes.push(`${x.to}|${x.title}|${x.body}`)); return m.map(() => ({ status: 'ok' as const, id: 'T' })); }, async receipts() { return {}; } };
  setPushTransport(t);
});
afterEach(() => { setGateway(undefined); pushes.length = 0; });
afterAll(async () => { setPushTransport(null); fakeApi.close(); await pool.end(); });

async function dist() {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }).expect(201);
  const token = `ExponentPushToken[sub-${r.body.id}]`;
  await request(app).post('/api/v1/devices').set(auth(r.body.access_token)).send({ token }).expect(204);
  return { id: r.body.id as number, token: r.body.access_token as string, push: token };
}
const setEnds = (d: { id: number }, offsetMs: number) => exec(pool, 'UPDATE distributor_profiles SET subscription_ends_at = ?, expiry_warned_at = NULL WHERE user_id = ?', [new Date(Date.now() + offsetMs), d.id]);
const ends = async (d: { id: number }) => +new Date((await q1<any>(pool, 'SELECT subscription_ends_at e FROM distributor_profiles WHERE user_id = ?', [d.id]))!.e);
const state = async (d: { token: string }) => (await request(app).get('/api/v1/subscription').set(auth(d.token)).expect(200)).body;
let k = 0;
const checkout = (d: { token: string }, body: object, key = 'sub-' + ++k) => request(app).post('/api/v1/subscription/checkout').set(auth(d.token)).set('Idempotency-Key', key).send(body);
const setCompany = () => request(app).put('/api/v1/admin/settings').set(auth(admin)).send({ company_upi_id: 'aayme@okaxis', company_payee: 'AAYME Technologies' }).expect(200);

describe('plans and the timer', () => {
  it('shows the plan, a live countdown and the available plans', async () => {
    const d = await dist();
    const s = await state(d);
    expect(s).toMatchObject({ plan_name: 'Trial', status: 'active', warn_days: 5, pay_by_upi: null, pending: null });
    expect(s.days_left).toBeGreaterThan(25); expect(s.seconds_left).toBeGreaterThan(25 * 86400);
    expect(s.plans.map((p: any) => [p.name, p.days, p.price])).toEqual([['Monthly', 30, '999.00'], ['Quarterly', 90, '2499.00'], ['Yearly', 365, '8999.00']]);
    await setEnds(d, 3 * day - 3600_000);
    expect(await state(d)).toMatchObject({ status: 'expiring', days_left: 3 });
    await setEnds(d, -day);
    expect(await state(d)).toMatchObject({ status: 'expired', seconds_left: 0, days_left: 0 });
  });

  it('the admin manages plans; past payments keep what they bought', async () => {
    const d = await dist(); await setCompany();
    const plan = (await request(app).post('/api/v1/admin/plans').set(auth(admin)).send({ name: 'Half-year', days: 180, price: '4999', sort_order: 5 }).expect(201)).body;
    expect(plan.price).toBe('4999.00');
    expect((await request(app).post('/api/v1/admin/plans').set(auth(admin)).send({ name: 'Free', days: 30, price: '0' })).status).toBe(400);
    const pay = (await checkout(d, { plan_id: plan.id, method: 'upi', utr: 'UTRSUBHALF01' }).expect(201)).body.payment;
    await request(app).put(`/api/v1/admin/plans/${plan.id}`).set(auth(admin)).send({ price: '9999', days: 90 }).expect(200);          // price and length change later
    const before = await ends(d);
    await request(app).post(`/api/v1/admin/subscription-payments/${pay.id}/confirm`).set(auth(admin)).expect(200);
    expect((await ends(d)) - before).toBe(180 * day);                                                                              // still the 180 days that were bought
    await request(app).put(`/api/v1/admin/plans/${plan.id}`).set(auth(admin)).send({ is_active: false }).expect(200);
    expect((await state(d)).plans.map((p: any) => p.name)).not.toContain('Half-year');
    await request(app).get('/api/v1/admin/plans').set(auth(d.token)).expect(403);
  });

  it('is for distributors only', async () => {
    const p = phone();
    const r = await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `r${p}@t.local`, name: 'Ret', password: 'password123', shop_name: 'Shop One', pincode: '400001' }).expect(201);
    await request(app).get('/api/v1/subscription').set(auth(r.body.access_token)).expect(403);
  });
});

describe('paying by UPI to the company', () => {
  it('waits for the admin, then adds the days on top of what is left', async () => {
    const d = await dist(); await setCompany();
    expect((await state(d)).pay_by_upi).toEqual({ upi_id: 'aayme@okaxis', payee: 'AAYME Technologies' });
    const monthly = (await state(d)).plans[0];

    expect((await checkout(d, { plan_id: monthly.id, method: 'upi' })).body.error.code).toBe('UTR_REQUIRED');
    expect((await checkout(d, { plan_id: 999999, method: 'upi', utr: 'UTRSUB000001' })).status).toBe(404);
    const made = await checkout(d, { plan_id: monthly.id, method: 'upi', utr: 'utrsub000002' }, 'once');
    expect(made.status).toBe(201); expect(made.body.payment).toMatchObject({ status: 'pending', amount: '999.00', utr: 'UTRSUB000002' });
    expect((await checkout(d, { plan_id: monthly.id, method: 'upi', utr: 'utrsub000002' }, 'once')).body.replayed).toBe(true);        // same key: same payment
    expect((await checkout(d, { plan_id: monthly.id, method: 'upi', utr: 'UTRSUB000003' })).body.error.code).toBe('PENDING_EXISTS');    // one at a time
    expect((await state(d)).pending.utr).toBe('UTRSUB000002');

    const waiting = (await request(app).get('/api/v1/admin/subscription-payments').set(auth(admin))).body.payments.find((p: any) => p.id === made.body.payment.id);
    expect(waiting).toMatchObject({ amount: '999.00', plan_name: 'Monthly', status: 'pending' });

    const was = await ends(d);
    const ok = await request(app).post(`/api/v1/admin/subscription-payments/${made.body.payment.id}/confirm`).set(auth(admin)).expect(200);
    expect(await ends(d)).toBe(was + 30 * day);                                  // paid early: no days are lost
    expect(+new Date(ok.body.ends_at)).toBe(was + 30 * day);
    expect((await state(d))).toMatchObject({ plan_name: 'Monthly', pending: null });
    await request(app).post(`/api/v1/admin/subscription-payments/${made.body.payment.id}/confirm`).set(auth(admin)).expect(200);       // pressed twice
    expect(await ends(d)).toBe(was + 30 * day);                                  // extended once
    expect((await state(d)).history[0]).toMatchObject({ status: 'confirmed' });
    for (let i = 0; i < 100 && !pushes.some((x) => x.includes('Subscription active')); i++) await sleep(30);
    expect(pushes.some((x) => x.startsWith(d.push) && x.includes('Subscription active'))).toBe(true);
  });

  it('an expired distributor can still pay, and the new period starts from now', async () => {
    const d = await dist(); await setCompany();
    await setEnds(d, -10 * day);
    await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'x', price: '1' }).expect(402);          // locked out of everything else
    const pay = (await checkout(d, { plan_id: (await state(d)).plans[0].id, method: 'upi', utr: 'UTRSUBEXP001' }).expect(201)).body.payment;
    const t0 = Date.now();
    await request(app).post(`/api/v1/admin/subscription-payments/${pay.id}/confirm`).set(auth(admin)).expect(200);
    expect(Math.abs((await ends(d)) - (t0 + 30 * day))).toBeLessThan(10_000);
    expect((await state(d)).status).toBe('active');
    await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'x', price: '1' }).expect(201);          // back in business
  });

  it('a payment that is not found can be rejected, and the same UTR can not be used twice', async () => {
    const a = await dist(); const b = await dist(); await setCompany();
    const plan = (await state(a)).plans[0].id;
    const pay = (await checkout(a, { plan_id: plan, method: 'upi', utr: 'UTRSUBREJ001' }).expect(201)).body.payment;
    const was = await ends(a);
    await request(app).post(`/api/v1/admin/subscription-payments/${pay.id}/reject`).set(auth(admin)).send({ note: 'No such payment in our bank' }).expect(200);
    expect(await ends(a)).toBe(was);
    expect((await request(app).post(`/api/v1/admin/subscription-payments/${pay.id}/confirm`).set(auth(admin))).status).toBe(409);   // decided already
    expect((await checkout(b, { plan_id: plan, method: 'upi', utr: 'UTRSUBREJ001' })).body.error.code).toBe('UTR_USED');
    await checkout(a, { plan_id: plan, method: 'upi', utr: 'UTRSUBREJ002' }).expect(201);                              // after a rejection they may try again
    await request(app).post(`/api/v1/admin/subscription-payments/${pay.id}/confirm`).set(auth(a.token)).expect(403);   // only the platform admin decides
  });

  it('needs the company UPI id to be set first', async () => {
    await exec(pool, "DELETE FROM platform_settings WHERE name IN ('company_upi_id','company_payee')");
    const d = await dist();
    expect((await checkout(d, { plan_id: (await state(d)).plans[0].id, method: 'upi', utr: 'UTRSUBNOUP01' })).status).toBe(501);
    expect((await request(app).put('/api/v1/admin/settings').set(auth(admin)).send({ company_upi_id: 'nope' })).status).toBe(400);
  });
});

describe('paying online (card / netbanking / UPI through the gateway)', () => {
  const hook = (payload: object, eventId = 'evt_' + crypto.randomBytes(4).toString('hex')) => {
    const raw = JSON.stringify(payload);
    return request(app).post('/api/v1/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', crypto.createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw);
  };
  const paid = (linkId: string, amountPaise: number) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: linkId, reference_id: 'sp_x', amount: amountPaise } }, payment: { entity: { id: 'pay_' + linkId.slice(-6), amount: amountPaise } } } });

  it('activates by itself when the gateway confirms the exact amount', async () => {
    setGateway(razorpay({ keyId: 'k', keySecret: 's', webhookSecret: SECRET, baseUrl: fakeUrl }));
    const d = await dist();
    expect((await state(d)).pay_by_gateway).toBe(true);
    const plan = (await state(d)).plans[1];                                      // Quarterly, 2499
    const made = await checkout(d, { plan_id: plan.id, method: 'gateway' }).expect(201);
    expect(made.body.checkout_url).toMatch(/^https:\/\/pay\.test\/plink_/);
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM subscription_payments WHERE id = ?', [made.body.payment.id]))!.gateway_ref;

    const was = await ends(d);
    expect((await hook(paid(ref, 249900), 'e1').then((r) => { return r; })).body.result).toBe('subscription_confirmed');
    expect(await ends(d)).toBe(was + 90 * day);
    expect((await state(d)).plan_name).toBe('Quarterly');
    expect((await hook(paid(ref, 249900), 'e2')).body.result).toBe('already_settled');                     // gateway retries
    expect(await ends(d)).toBe(was + 90 * day);
  });

  it('keeps a wrong amount out of the account and for review', async () => {
    setGateway(razorpay({ keyId: 'k', keySecret: 's', webhookSecret: SECRET, baseUrl: fakeUrl }));
    const d = await dist();
    const made = await checkout(d, { plan_id: (await state(d)).plans[2].id, method: 'gateway' }).expect(201);
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM subscription_payments WHERE id = ?', [made.body.payment.id]))!.gateway_ref;
    const was = await ends(d);
    expect((await hook(paid(ref, 1000))).body.result).toBe('amount_mismatch');
    expect(await ends(d)).toBe(was);
    expect((await q1<any>(pool, 'SELECT status FROM subscription_payments WHERE id = ?', [made.body.payment.id]))!.status).toBe('failed');
    expect((await q<any>(pool, "SELECT id FROM audit_log WHERE action = 'payment.gateway_amount_mismatch'")).length).toBeGreaterThan(0);
  });

  it('is unavailable without a gateway', async () => {
    const d = await dist();
    expect((await checkout(d, { plan_id: (await state(d)).plans[0].id, method: 'gateway' })).status).toBe(501);
  });
});

describe('warnings before the subscription ends', () => {
  it('starts 5 days before, once a day, says how many days are left, and tells them when it has ended', async () => {
    const d = await dist(); const far = await dist(); const gone = await dist();
    await setEnds(d, 4.5 * day);                                // 5 days left (rounded up)
    await setEnds(far, 20 * day);
    await setEnds(gone, -2 * 3600_000);                          // ended two hours ago

    const first = await runExpiryWarnings(5);
    expect(first).toContain(d.id); expect(first).toContain(gone.id); expect(first).not.toContain(far.id);
    expect(await runExpiryWarnings(5)).not.toContain(d.id);     // already told today
    expect(await runExpiryWarnings(5)).not.toContain(gone.id);  // the "ended" notice goes out once
    for (let i = 0; i < 100 && pushes.length < 2; i++) await sleep(30);
    expect(pushes.find((x) => x.startsWith(d.push))).toContain('ends in 5 days');
    expect(pushes.find((x) => x.startsWith(gone.push))).toContain('Subscription ended');

    // tomorrow: the daily reminder comes again (simulated by moving "last warned" back a day) with a smaller number
    await exec(pool, 'UPDATE distributor_profiles SET expiry_warned_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), subscription_ends_at = ? WHERE user_id = ?', [new Date(Date.now() + 3.5 * day), d.id]);
    pushes.length = 0;
    expect(await runExpiryWarnings(5)).toContain(d.id);
    for (let i = 0; i < 100 && !pushes.length; i++) await sleep(30);
    expect(pushes[0]).toContain('ends in 4 days');

    // paying clears it, so the next period gets its own warnings
    await setEnds(d, 2 * day);
    await exec(pool, 'UPDATE distributor_profiles SET expiry_warned_at = UTC_TIMESTAMP() WHERE user_id = ?', [d.id]);
    await setCompany();
    const pay = (await checkout(d, { plan_id: (await state(d)).plans[0].id, method: 'upi', utr: 'UTRSUBWARN01' }).expect(201)).body.payment;
    await request(app).post(`/api/v1/admin/subscription-payments/${pay.id}/confirm`).set(auth(admin)).expect(200);
    expect((await q1<any>(pool, 'SELECT expiry_warned_at w FROM distributor_profiles WHERE user_id = ?', [d.id]))!.w).toBeNull();
    expect(await runExpiryWarnings(5)).not.toContain(d.id);     // 32 days left now: nothing to warn about
  });
});
