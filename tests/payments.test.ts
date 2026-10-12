import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1, withTx } from '../src/db/pool';
import { postLedger } from '../src/modules/ledger/ledger.service';
import { razorpay, setGateway } from '../src/services/gateway';

const app = createApp();
let n = 0;
const phone = () => String(7600000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SECRET = 'whsec_test';

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
async function pair() {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  return { d, r };
}
const owe = (d: { token: string }, r: { id: number }, amount: string, key: string) =>
  request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', key).send({ retailer_id: r.id, transaction_type: 'debit_note', amount }).expect(201);
const balance = async (d: { token: string }, r: { id: number }) => (await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token))).body.balance_due;

/** A stand-in for Razorpay's API. */
let fakeApi: http.Server; let fakeUrl = ''; const apiCalls: any[] = []; let apiMode: 'ok' | 'down' = 'ok';
beforeAll(async () => {
  await migrate(true);
  fakeApi = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      apiCalls.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      if (apiMode === 'down') { res.statusCode = 500; return void res.end('{"error":{"description":"boom"}}'); }
      const id = 'plink_' + crypto.randomBytes(6).toString('hex');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}` }));
    });
  });
  await new Promise<void>((ok) => fakeApi.listen(0, '127.0.0.1', ok));
  fakeUrl = `http://127.0.0.1:${(fakeApi.address() as any).port}`;
});
afterEach(() => { setGateway(undefined); apiMode = 'ok'; });
afterAll(async () => { fakeApi.close(); await pool.end(); });

const gw = () => razorpay({ keyId: 'rzp_test_key', keySecret: 'sekret', webhookSecret: SECRET, baseUrl: fakeUrl });
const hook = (payload: object, opts: { eventId?: string; badSig?: boolean } = {}) => {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return request(app).post('/api/v1/payments/webhook').set('Content-Type', 'application/json')
    .set('x-razorpay-event-id', opts.eventId ?? 'evt_' + crypto.randomBytes(5).toString('hex'))
    .set('x-razorpay-signature', opts.badSig ? sig.replace(/.$/, sig.endsWith('0') ? '1' : '0') : sig).send(raw);
};
const paid = (linkId: string, refId: string, amountPaise: number) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: linkId, reference_id: refId, amount: amountPaise, status: 'paid' } }, payment: { entity: { id: 'pay_' + linkId.slice(-6), amount: amountPaise } } } });

describe('gateway adapter', () => {
  it('checks signatures exactly and understands the events', () => {
    const g = gw(); const raw = Buffer.from('{"a":1}'); const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(g.verifyWebhook(raw, sig)).toBe(true);
    expect(g.verifyWebhook(Buffer.from('{"a":2}'), sig)).toBe(false);          // body tampered
    expect(g.verifyWebhook(raw, undefined)).toBe(false);
    expect(g.verifyWebhook(raw, sig.slice(0, -1))).toBe(false);
    expect(g.parseWebhook(paid('plink_1', 'pi_9', 5000), { 'x-razorpay-event-id': 'e1' })).toMatchObject({ kind: 'paid', linkId: 'plink_1', amountPaise: 5000, paymentId: 'pay_link_1' });
    expect(g.parseWebhook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: 'plink_1' } } } }, { 'x-razorpay-event-id': 'e2' }).kind).toBe('failed');
    expect(g.parseWebhook({ event: 'order.paid', payload: {} }, { 'x-razorpay-event-id': 'e3' }).kind).toBe('ignored');
    expect(g.parseWebhook(paid('plink_1', 'x', 1), {}).kind).toBe('ignored');   // no event id => can not be made safe to repeat
  });
});

describe('paying online', () => {
  it('is off until a gateway is configured', async () => {
    const { d, r } = await pair();
    expect((await request(app).get('/api/v1/payments/methods').set(auth(r.token))).body).toEqual({ upi: true, gateway: false });
    const res = await request(app).post('/api/v1/payments/gateway/link').set(auth(r.token)).set('Idempotency-Key', 'g0').send({ distributor_id: d.id, amount: '100' });
    expect(res.status).toBe(501);
  });

  it('creates a link, then ONLY the signed webhook moves the khata (and only once)', async () => {
    setGateway(gw());
    const { d, r } = await pair();
    await owe(d, r, '1000', 'o1');
    expect((await request(app).get('/api/v1/payments/methods').set(auth(r.token))).body.gateway).toBe(true);

    const mk = (key = 'g1', amount = '400') => request(app).post('/api/v1/payments/gateway/link').set(auth(r.token)).set('Idempotency-Key', key).send({ distributor_id: d.id, amount });
    const made = await mk(); expect(made.status).toBe(201);
    expect(made.body.checkout_url).toMatch(/^https:\/\/rzp\.io\/i\/plink_/);
    const call = apiCalls.at(-1);
    expect(call.url).toBe('/v1/payment_links');
    expect(call.auth).toBe('Basic ' + Buffer.from('rzp_test_key:sekret').toString('base64'));
    expect(call.body).toMatchObject({ amount: 40000, currency: 'INR', reference_id: `pi_${made.body.payment.id}`, accept_partial: false });
    expect(call.body.customer.contact).toBe('+91' + r.phone);

    const again = await mk(); expect(again.status).toBe(200); expect(again.body.replayed).toBe(true);     // same key: same link
    expect(again.body.checkout_url).toBe(made.body.checkout_url);
    expect((await mk('g1', '999')).status).toBe(422);                                                  // same key, different amount
    expect(await balance(d, r)).toBe('1000.00');                                                       // nothing moved yet

    const intent = (await q1<any>(pool, 'SELECT gateway_ref FROM payment_intents WHERE id = ?', [made.body.payment.id]))!;
    await request(app).post(`/api/v1/payments/${made.body.payment.id}/confirm`).set(auth(d.token)).expect(409);   // can not be confirmed by hand

    const ev = paid(intent.gateway_ref, `pi_${made.body.payment.id}`, 40000);
    expect((await hook(ev, { badSig: true })).status).toBe(401);
    expect(await balance(d, r)).toBe('1000.00');                                                       // a forged call changes nothing

    const ok = await hook(ev, { eventId: 'evt_one' });
    expect(ok.status).toBe(200); expect(ok.body.result).toBe('confirmed');
    expect(await balance(d, r)).toBe('600.00');
    expect((await hook(ev, { eventId: 'evt_one' })).body.result).toBe('already_settled');              // the gateway retries
    expect((await hook(ev, { eventId: 'evt_two' })).body.result).toBe('already_settled');              // even under a new event id
    expect(await balance(d, r)).toBe('600.00');

    const list = (await request(app).get('/api/v1/payments').set(auth(r.token))).body.payments;
    expect(list[0]).toMatchObject({ status: 'confirmed', method: 'gateway' });
  });

  it('holds a payment of the wrong amount for review instead of guessing', async () => {
    setGateway(gw());
    const { d, r } = await pair();
    await owe(d, r, '500', 'o2');
    const made = (await request(app).post('/api/v1/payments/gateway/link').set(auth(r.token)).set('Idempotency-Key', 'g2').send({ distributor_id: d.id, amount: '300' })).body;
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM payment_intents WHERE id = ?', [made.payment.id]))!.gateway_ref;
    const res = await hook(paid(ref, `pi_${made.payment.id}`, 25000));
    expect(res.body.result).toBe('amount_mismatch');
    expect(await balance(d, r)).toBe('500.00');
    const rec = (await request(app).get('/api/v1/collections/reconciliation').set(auth(d.token))).body;
    expect(rec.ok).toBe(false);
    expect(rec.gateway_paid_wrong_amount).toHaveLength(1);
  });

  it('records an expired link as failed, and ignores unknown or unrelated events', async () => {
    setGateway(gw());
    const { d, r } = await pair();
    const made = (await request(app).post('/api/v1/payments/gateway/link').set(auth(r.token)).set('Idempotency-Key', 'g3').send({ distributor_id: d.id, amount: '50' })).body;
    const ref = (await q1<any>(pool, 'SELECT gateway_ref FROM payment_intents WHERE id = ?', [made.payment.id]))!.gateway_ref;
    expect((await hook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: ref } } } })).body.result).toBe('failed');
    expect((await q1<any>(pool, 'SELECT status FROM payment_intents WHERE id = ?', [made.payment.id]))!.status).toBe('failed');
    expect((await hook(paid('plink_nobody', 'pi_0', 100))).body.result).toBe('unknown_reference');
    expect((await hook({ event: 'order.paid', payload: {} })).body.ignored).toBe(true);
  });

  it('survives a gateway outage without charging or leaving a pending payment', async () => {
    setGateway(gw()); apiMode = 'down';
    const { d, r } = await pair();
    const res = await request(app).post('/api/v1/payments/gateway/link').set(auth(r.token)).set('Idempotency-Key', 'g4').send({ distributor_id: d.id, amount: '100' });
    expect(res.status).toBe(502); expect(res.body.error.code).toBe('GATEWAY_ERROR');
    expect((await q1<any>(pool, 'SELECT status FROM payment_intents WHERE retailer_id = ?', [r.id]))!.status).toBe('failed');
  });

  it('refuses limits, strangers and non-retailers', async () => {
    setGateway(gw());
    const { d, r } = await pair(); const other = await reg('distributor');
    const mk = (who: { token: string }, body: object) => request(app).post('/api/v1/payments/gateway/link').set(auth(who.token)).set('Idempotency-Key', 'k' + Math.random()).send(body);
    expect((await mk(r, { distributor_id: d.id, amount: '0.50' })).status).toBe(400);
    expect((await mk(r, { distributor_id: d.id, amount: '600000' })).status).toBe(400);
    expect((await mk(r, { distributor_id: other.id, amount: '10' })).status).toBe(404);   // not linked
    expect((await mk(d, { distributor_id: d.id, amount: '10' })).status).toBe(403);
  });
});

describe('reconciliation', () => {
  it('is clean when everything agrees and flags what does not', async () => {
    const { d, r } = await pair();
    await owe(d, r, '300', 'rc1');
    const pay = (await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'rp1').send({ distributor_id: d.id, amount: '100', utr: 'UTRRECON0001' }).expect(201)).body.payment;
    await request(app).post(`/api/v1/payments/${pay.id}/confirm`).set(auth(d.token)).expect(200);
    const get = async () => (await request(app).get('/api/v1/collections/reconciliation').set(auth(d.token)).expect(200)).body;
    let rec = await get();
    expect(rec).toMatchObject({ ok: true, totals: { confirmed_payments: '100.00', online_in_khata: '100.00', difference: '0.00' } });

    // an online-payment entry in the khata with no payment behind it
    await withTx((c) => postLedger(c, { distributorId: d.id, retailerId: r.id, type: 'payment_online', amountPaise: 5000, createdBy: d.id, idempotencyKey: 'manual-oddity' }));
    // a payment waiting for more than two days
    const old = (await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'rp2').send({ distributor_id: d.id, amount: '20', utr: 'UTRRECON0002' }).expect(201)).body.payment;
    await exec(pool, 'UPDATE payment_intents SET created_at = DATE_SUB(created_at, INTERVAL 3 DAY) WHERE id = ?', [old.id]);
    // a confirmed payment whose khata entry is missing
    const lost = (await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'rp3').send({ distributor_id: d.id, amount: '30', utr: 'UTRRECON0003' }).expect(201)).body.payment;
    await exec(pool, "UPDATE payment_intents SET status = 'confirmed' WHERE id = ?", [lost.id]);

    rec = await get();
    expect(rec.ok).toBe(false);
    expect(rec.khata_entries_without_payment).toHaveLength(1);
    expect(rec.pending_over_48h.map((x: any) => x.id)).toContain(old.id);
    expect(rec.confirmed_without_khata_entry.map((x: any) => x.id)).toEqual([lost.id]);
  });

  it('only shows a distributor their own books', async () => {
    const { d } = await pair(); const other = await pair();
    await withTx((c) => postLedger(c, { distributorId: other.d.id, retailerId: other.r.id, type: 'payment_online', amountPaise: 100, createdBy: other.d.id, idempotencyKey: 'x-other' }));
    expect((await request(app).get('/api/v1/collections/reconciliation').set(auth(d.token))).body.khata_entries_without_payment).toHaveLength(0);
    await request(app).get('/api/v1/admin/reconciliation').set(auth(d.token)).expect(403);
  });
});

describe('statement export', () => {
  it('downloads the whole khata as a spreadsheet, safely', async () => {
    const { d, r } = await pair(); const stranger = await reg('retailer');
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'csv1').send({ retailer_id: r.id, transaction_type: 'debit_note', amount: '250.50', notes: '=HYPERLINK("http://evil","click")' }).expect(201);
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'csv2').send({ retailer_id: r.id, transaction_type: 'payment_cash', amount: '100', cash_denominations: { '100': 1 }, notes: 'Said "thanks", paid' }).expect(201);

    const res = await request(app).get('/api/v1/ledger/statement.csv').query({ retailer_id: r.id }).set(auth(d.token)).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Date (UTC),Entry no.,Type,Order,Debit (owed),Credit (paid),Balance after,Mode,Notes');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('250.50,,250.50');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);          // formula neutralised, quotes escaped
    expect(lines[2]).toContain(',100.00,150.50,');
    expect(lines[2]).toContain('"Said ""thanks"", paid"');

    // the retailer can export the same account; a stranger can not
    const mine = await request(app).get('/api/v1/ledger/statement.csv').query({ distributor_id: d.id }).set(auth(r.token)).expect(200);
    expect(mine.text).toContain('250.50');
    await request(app).get('/api/v1/ledger/statement.csv').query({ distributor_id: d.id }).set(auth(stranger.token)).expect(404);
    await request(app).get('/api/v1/ledger/statement.csv').set(auth(r.token)).expect(400);
  });
});
