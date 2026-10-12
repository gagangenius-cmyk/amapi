import { AddressInfo } from 'net';
import { createServer, Server as HttpServer } from 'http';
import { io as connect } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool, q, q1 } from '../src/db/pool';
import { attachSocket } from '../src/modules/chat/chat.routes';
import { signAccess } from '../src/middleware/auth';
import { testOutbox } from '../src/services/mailer';
import { runCleanup } from '../src/jobs/subscriptionWarnings';

// Regression tests for problems found in the project review. Each one failed before it was fixed.
const app = createApp();
let n = 0;
const phone = () => String(5000000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let http: HttpServer;
let base: string;

async function reg(role: 'distributor' | 'retailer', extra: object = {}) {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@h.test`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@h.test`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send({ ...body, ...extra });
  expect(r.status).toBe(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p, email: `${role === 'distributor' ? 'd' : 'r'}${p}@h.test` };
}
async function link(d: { token: string; id: number }, r: { token: string; phone: string }) {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
}
const product = async (token: string, stock = 10, price = '10') => (await request(app).post('/api/v1/catalog').set(auth(token)).send({ name: 'item', price, stock_qty: stock })).body.id as number;
const order = (token: string, distributorId: number, productId: number, qty = 1, key = `k-${Math.random()}`) =>
  request(app).post('/api/v1/orders').set(auth(token)).set('Idempotency-Key', key).send({ distributor_id: distributorId, items: [{ product_id: productId, qty }] });
const balance = async (d: { token: string }, retailerId: number) => (await request(app).get('/api/v1/ledger/statement').query({ retailer_id: retailerId }).set(auth(d.token))).body.balance_due as string;

beforeAll(async () => {
  process.env.OTP_DEV_ECHO = '1';
  await migrate(true);
  http = createServer(app);
  await attachSocket(http);
  await new Promise<void>((res) => http.listen(0, res));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { http.close(); await pool.end(); });

describe('retailer consent (no unilateral debts)', () => {
  it('a distributor can only REQUEST a link; nothing can be posted until the retailer accepts', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    const req1 = await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    // identical answer for a number that is not a retailer: phone numbers cannot be probed
    const ghost = await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: '1234567890' }).expect(202);
    expect(ghost.body).toEqual(req1.body);

    // pending: no debit note, no chat, no payment, not in the retailer's accounts, only a phone in the distributor's list
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c1').send({ retailer_id: r.id, transaction_type: 'debit_note', amount: '50000' }).expect(404);
    await request(app).post('/api/v1/chat/messages').set(auth(d.token)).send({ retailer_id: r.id, body: 'hi' }).expect(404);
    expect((await request(app).get('/api/v1/retailer/distributors').set(auth(r.token))).body.distributors).toEqual([]);
    const list = (await request(app).get('/api/v1/distributor/retailers').set(auth(d.token))).body;
    expect(list.retailers).toEqual([]);
    expect(list.pending).toEqual([{ id: r.id, phone: r.phone }]);

    const reqs = (await request(app).get('/api/v1/retailer/link-requests').set(auth(r.token))).body.requests;
    expect(reqs.map((x: any) => x.id)).toEqual([d.id]);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'c2').send({ retailer_id: r.id, transaction_type: 'debit_note', amount: '100' }).expect(201);
    // first supplier becomes the pinned one
    expect((await request(app).get('/api/v1/retailer/distributors').set(auth(r.token))).body.distributors[0]).toMatchObject({ id: d.id, is_primary: true });
  });

  it('a retailer can decline a request, and another retailer cannot answer it', async () => {
    const d = await reg('distributor'); const r = await reg('retailer'); const other = await reg('retailer');
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(other.token)).expect(404);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/decline`).set(auth(r.token)).expect(204);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(404);
    expect((await request(app).get('/api/v1/distributor/retailers').set(auth(d.token))).body.pending).toEqual([]);
  });
});

describe('disputes', () => {
  it('a retailer can contest an entry; the distributor reverses it or explains why it stands', async () => {
    const d = await reg('distributor'); const r = await reg('retailer'); const other = await reg('retailer');
    await link(d, r);
    const debit = (await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'x1').send({ retailer_id: r.id, transaction_type: 'debit_note', amount: '700' })).body.transaction;
    expect(await balance(d, r.id)).toBe('700.00');

    await request(app).post(`/api/v1/ledger/transaction/${debit.id}/dispute`).set(auth(other.token)).send({ reason: 'not mine' }).expect(404);
    await request(app).post(`/api/v1/ledger/transaction/${debit.id}/dispute`).set(auth(r.token)).send({ reason: 'x' }).expect(400);
    await request(app).post(`/api/v1/ledger/transaction/${debit.id}/dispute`).set(auth(r.token)).send({ reason: 'I never bought this' }).expect(201);
    await request(app).post(`/api/v1/ledger/transaction/${debit.id}/dispute`).set(auth(r.token)).send({ reason: 'again' }).expect(409);

    const st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token));
    expect(st.body.transactions[0].dispute).toMatchObject({ status: 'open', reason: 'I never bought this' });
    const open = (await request(app).get('/api/v1/ledger/disputes').set(auth(d.token))).body.disputes;
    expect(open).toHaveLength(1);
    await request(app).post(`/api/v1/ledger/disputes/${open[0].id}/resolve`).set(auth(r.token)).send({ action: 'reverse' }).expect(403);
    await request(app).post(`/api/v1/ledger/disputes/${open[0].id}/resolve`).set(auth(d.token)).send({ action: 'reject' }).expect(400); // must explain
    await request(app).post(`/api/v1/ledger/disputes/${open[0].id}/resolve`).set(auth(d.token)).send({ action: 'reverse' }).expect(200);
    expect(await balance(d, r.id)).toBe('0.00');
    await request(app).post(`/api/v1/ledger/disputes/${open[0].id}/resolve`).set(auth(d.token)).send({ action: 'reverse' }).expect(409);
    expect((await request(app).get('/api/v1/ledger/disputes').set(auth(r.token))).body.disputes[0].status).toBe('resolved');

    // a rejected dispute leaves the balance alone and records the explanation
    const debit2 = (await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'x2').send({ retailer_id: r.id, transaction_type: 'debit_note', amount: '30' })).body.transaction;
    const dsp = (await request(app).post(`/api/v1/ledger/transaction/${debit2.id}/dispute`).set(auth(r.token)).send({ reason: 'wrong amount' })).body.dispute;
    await request(app).post(`/api/v1/ledger/disputes/${dsp.id}/resolve`).set(auth(d.token)).send({ action: 'reject', note: 'Delivery slip signed on 3rd' }).expect(200);
    expect(await balance(d, r.id)).toBe('30.00');
    expect((await request(app).get('/api/v1/ledger/disputes').set(auth(r.token))).body.disputes[0]).toMatchObject({ status: 'rejected', resolution_note: 'Delivery slip signed on 3rd' });
  });
});

describe('append-only history is enforced by the database', () => {
  it('rejects UPDATE and DELETE on ledger and audit rows, whoever runs them', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    await request(app).post('/api/v1/ledger/transaction').set(auth(d.token)).set('Idempotency-Key', 'imm').send({ retailer_id: r.id, transaction_type: 'debit_note', amount: '5' }).expect(201);
    await order(r.token, d.id, await product(d.token)).then((o) => expect(o.status).toBe(201)); // creates an order_events row
    await expect(pool.query('UPDATE ledger_transactions SET amount_paise = 1')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_transactions')).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM order_events')).rejects.toThrow(/append-only/);
    expect((await q1<any>(pool, 'SELECT COUNT(*) n FROM ledger_transactions'))!.n).toBeGreaterThan(0);
  });
});

describe('tokens and accounts', () => {
  it('rejects the invoice link token and tokens of deleted accounts straight away', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const pid = await product(d.token);
    const oid = (await order(r.token, d.id, pid)).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    const url = (await request(app).get(`/api/v1/orders/${oid}/invoice-link`).set(auth(r.token))).body.url as string;
    const t = url.split('t=')[1];
    for (const path of ['/api/v1/orders', '/api/v1/me/export', '/api/v1/chat/conversations']) await request(app).get(path).set(auth(t)).expect(401);
    await request(app).post('/api/v1/devices').set(auth(t)).send({ token: 'ExponentPushToken[aaaaaaaaaaaa]' }).expect(401);

    // deleted account: its access token dies immediately instead of living on for 15 minutes
    const gone = await reg('retailer');
    await request(app).get('/api/v1/orders').set(auth(gone.token)).expect(200);
    await request(app).delete('/api/v1/me').set(auth(gone.token)).send({ password: 'password123' }).expect(204);
    await request(app).get('/api/v1/orders').set(auth(gone.token)).expect(401);
  });

  it('answers malformed ids with 400, not a server error', async () => {
    const r = await reg('retailer');
    for (const path of ['/api/v1/orders/abc', '/api/v1/orders/-1', '/api/v1/orders/1e9999', '/api/v1/orders/0'])
      expect((await request(app).get(path).set(auth(r.token))).status).toBe(400);
    await request(app).post('/api/v1/orders/abc/transition').set(auth(r.token)).send({ to: 'cancelled' }).expect(400);
  });

  it('two sign-ups racing for one phone: one wins, the rest get a clean 409', async () => {
    const p = phone();
    const attempt = (i: number) => request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `race${i}${p}@h.test`, name: 'Race', password: 'password123', shop_name: 'Shop', pincode: '400001' });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(attempt));
    expect(rs.map((x) => x.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });

  it('locks the account after 10 wrong passwords, but emailed-code sign-in still works', async () => {
    const u = await reg('retailer');
    for (let i = 0; i < 10; i++) await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: `wrong-pass-${i}` }).expect(401);
    const locked = await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: 'password123' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'login' }).expect(202);
    const code = [...testOutbox].reverse().find((m) => m.to === u.email && m.subject.includes('verification code'))!.text.match(/\b(\d{6})\b/)![1];
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'login', code }).expect(200);

    await pool.query('UPDATE users SET locked_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [u.id]);
    await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: 'password123' }).expect(200);
    expect((await q1<any>(pool, 'SELECT failed_logins, locked_until FROM users WHERE id = ?', [u.id]))).toMatchObject({ failed_logins: 0, locked_until: null });
  });
});

describe('email verification', () => {
  it('sends a code at sign-up, confirms the address, and resets confirmation when the email changes', async () => {
    const u = await reg('retailer');
    const mail = [...testOutbox].reverse().find((m) => m.to === u.email)!;
    expect(mail.text).toContain('confirm your email address');
    const code = mail.text.match(/\b(\d{6})\b/)![1];
    expect((await request(app).get('/api/v1/me').set(auth(u.token))).body).toMatchObject({ email: u.email, email_verified: false });
    const wrong = code === '000000' ? '111111' : '000000';
    await request(app).post('/api/v1/auth/email/verify').set(auth(u.token)).send({ code: wrong }).expect(401);
    await request(app).post('/api/v1/auth/email/verify').set(auth(u.token)).send({ code }).expect(200);
    expect((await request(app).get('/api/v1/me').set(auth(u.token))).body.email_verified).toBe(true);
    await request(app).post('/api/v1/auth/email/send-verification').set(auth(u.token)).expect(200); // already verified: no new mail needed

    const before = testOutbox.length;
    const ch = await request(app).put('/api/v1/me/email').set(auth(u.token)).send({ email: `new${u.phone}@h.test`, password: 'password123' }).expect(200);
    expect(ch.body.email_verified).toBe(false);
    expect(testOutbox.length).toBe(before + 1);
    expect(testOutbox[testOutbox.length - 1].to).toBe(`new${u.phone}@h.test`);
  });
});

describe('orders: replay, service area, hierarchy, cancel', () => {
  it('rejects a reused Idempotency-Key with a different cart', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const a = await product(d.token, 50); const b = await product(d.token, 50, '99');
    const first = await order(r.token, d.id, a, 1, 'same');
    expect(first.status).toBe(201);
    const again = await order(r.token, d.id, a, 1, 'same');
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const clash = await order(r.token, d.id, b, 5, 'same');
    expect(clash.status).toBe(422);
    expect(clash.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('enforces the service area for strangers but not for linked suppliers', async () => {
    const far = await reg('distributor'); const r = await reg('retailer');
    await request(app).put('/api/v1/distributor/pincodes').set(auth(far.token)).send({ pincodes: ['999999'] }).expect(200);
    const pid = await product(far.token);
    const blocked = await order(r.token, far.id, pid);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('NOT_SERVICEABLE');
    await link(far, r); // an explicit relationship overrides the pincode rule
    expect((await order(r.token, far.id, pid)).status).toBe(201);
  });

  it('does not charge commission on a first order, and pins that supplier', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await request(app).put('/api/v1/distributor/pincodes').set(auth(d.token)).send({ pincodes: ['400001'] }).expect(200);
    const o = await order(r.token, d.id, await product(d.token));
    expect(o.body.order).toMatchObject({ is_out_of_hierarchy: false, commission_rate_bps: 0 });
    expect((await request(app).get('/api/v1/retailer/distributors').set(auth(r.token))).body.distributors[0]).toMatchObject({ id: d.id, is_primary: true });
  });

  it('cancelling an accepted order still works after the invoice was reversed by hand', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const pid = await product(d.token, 5);
    const oid = (await order(r.token, d.id, pid, 2)).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    const inv = await q1<any>(pool, "SELECT id FROM ledger_transactions WHERE order_id = ? AND type = 'invoice'", [oid]);
    await request(app).post(`/api/v1/ledger/transaction/${inv!.id}/reverse`).set(auth(d.token)).set('Idempotency-Key', 'rv').expect(201);
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'cancelled' }).expect(200);
    expect(await balance(d, r.id)).toBe('0.00');
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(5); // stock came back
  });

  it('accepting without the khata feature still deducts stock and does not touch the ledger', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    await pool.query("UPDATE distributor_profiles SET permissions = '{\"khatabook_enabled\":false}' WHERE user_id = ?", [d.id]);
    const pid = await product(d.token, 5);
    const oid = (await order(r.token, d.id, pid, 2)).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
    expect((await q<any>(pool, 'SELECT id FROM ledger_transactions WHERE order_id = ?', [oid]))).toHaveLength(0);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(3);
  });
});

describe('payment details and staff access', () => {
  it('hides the bank account from delivery staff and accepts a UPI id on its own', async () => {
    const d = await reg('distributor');
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { upi_id: 'shop@okhdfc' } }).expect(200);
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { upi_id: 'not a upi id' } }).expect(400);
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { account_name: 'Owner' } }).expect(400); // incomplete bank details
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { account_name: 'Owner', account_no: '12', ifsc: 'bad' } }).expect(400);
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { upi_id: 'shop@okhdfc', account_name: 'Owner', account_no: '123456789012', ifsc: 'hdfc0001234' } }).expect(200);

    const ep = phone();
    await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: ep, name: 'Agent', password: 'password123' }).expect(201);
    const eTok = (await request(app).post('/api/v1/auth/login').send({ phone: ep, password: 'password123' })).body.access_token;
    const mine = await request(app).get('/api/v1/distributor/me').set(auth(d.token)).expect(200);
    expect(mine.body.bank_account_details).toMatchObject({ account_no: '123456789012', ifsc: 'HDFC0001234' });
    const staff = await request(app).get('/api/v1/distributor/me').set(auth(eTok)).expect(200);
    expect(staff.body.bank_account_details).toBeNull();
    expect(staff.body.upi_enabled).toBe(true);
    expect(JSON.stringify(staff.body)).not.toContain('123456789012');
  });
});

describe('chat sockets', () => {
  const connectAs = (token: string) => new Promise<any>((res, rej) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
  });

  it('refuses non-access tokens and closed accounts, and limits message floods', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    await expect(connectAs('garbage')).rejects.toBeTruthy();
    await expect(connectAs(signAccess({ userId: 999999, role: 'retailer' }))).rejects.toBeTruthy(); // no such user

    const s = await connectAs(r.token);
    let ok = 0; let limited = 0;
    for (let i = 0; i < 25; i++) {
      const ack = await s.timeout(5000).emitWithAck('message:send', { distributor_id: d.id, body: `m${i}` });
      if (ack.ok) ok++; else if (ack.error.code === 'RATE_LIMIT') limited++;
    }
    expect(ok).toBe(20);
    expect(limited).toBe(5);
    s.close();
  });
});

describe('startup safety checks', () => {
  const load = async (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
    vi.resetModules();
    try { return await import('../src/config/env.js'); } finally { process.env = saved; }
  };

  it('refuses to start without a JWT secret, with a weak one, or with dev settings in production', async () => {
    await expect(load({ NODE_ENV: 'development', JWT_SECRET: undefined })).rejects.toThrow(/JWT_SECRET is not set/);
    await expect(load({ NODE_ENV: 'development', JWT_SECRET: 'short' })).rejects.toThrow(/too weak/);
    await expect(load({ NODE_ENV: 'production', JWT_SECRET: 'dev-secret-please-change-0123456789abcdef', DB_PASSWORD: 'x' })).rejects.toThrow(/at least 32/);
    await expect(load({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), DB_PASSWORD: '' })).rejects.toThrow(/DB_PASSWORD/);
    await expect(load({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), DB_PASSWORD: 'x', OTP_DEV_ECHO: '1', DB_USER: 'app' })).rejects.toThrow(/OTP_DEV_ECHO/);
    await expect(load({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), DB_PASSWORD: 'x', DB_USER: 'root', OTP_DEV_ECHO: undefined })).rejects.toThrow(/root user/);
    const ok = await load({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), DB_PASSWORD: 'x', DB_USER: 'app', OTP_DEV_ECHO: undefined });
    expect(ok.env.otpDevEcho).toBe(false);
  });

  it('never echoes OTP codes in production, even if the flag is somehow set later', async () => {
    const mod = await load({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), DB_PASSWORD: 'x', DB_USER: 'app', OTP_DEV_ECHO: undefined });
    process.env.OTP_DEV_ECHO = '1';
    try { expect(mod.env.otpDevEcho).toBe(false); } finally { process.env.OTP_DEV_ECHO = '1'; }
  });
});

describe('housekeeping and paging', () => {
  it('purges dead tokens and old codes but keeps live ones', async () => {
    const u = await reg('retailer');
    await pool.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY))", [u.id, 'a'.repeat(64)]);
    await pool.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY))", [u.id, 'b'.repeat(64)]);
    await pool.query("INSERT INTO otps (identifier, purpose, code_hash, expires_at, created_at) VALUES ('old@x.test', 'login', ?, UTC_TIMESTAMP(), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY))", ['c'.repeat(64)]);
    const live = (await q<any>(pool, 'SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = ? AND token_hash NOT IN (?, ?)', [u.id, 'a'.repeat(64), 'b'.repeat(64)]))[0].n;
    const res = await runCleanup();
    expect(res.refresh_tokens).toBeGreaterThanOrEqual(2);
    expect(res.otps).toBeGreaterThanOrEqual(1);
    expect((await q<any>(pool, 'SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = ?', [u.id]))[0].n).toBe(live); // the live session survives
  });

  it('pages the order list with a cursor and rejects unknown statuses', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await link(d, r);
    const pid = await product(d.token, 100);
    for (let i = 0; i < 5; i++) await order(r.token, d.id, pid, 1, `pg${i}`).then((o) => expect(o.status).toBe(201));
    const page1 = (await request(app).get('/api/v1/orders?limit=2').set(auth(r.token)).expect(200)).body;
    expect(page1.orders).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    const page2 = (await request(app).get(`/api/v1/orders?limit=2&before=${page1.next_before}`).set(auth(r.token)).expect(200)).body;
    expect(page2.orders.map((o: any) => o.id)).toEqual([page1.orders[1].id - 1, page1.orders[1].id - 2]);
    const last = (await request(app).get(`/api/v1/orders?limit=2&before=${page2.next_before}`).set(auth(r.token)).expect(200)).body;
    expect(last.orders).toHaveLength(1);
    expect(last.has_more).toBe(false);
    await request(app).get('/api/v1/orders?status=bogus').set(auth(r.token)).expect(400);
    // each order says who it is with and how many lines it has, so the app can show names instead of ids
    expect(page1.orders[0]).toMatchObject({ retailer_name: expect.stringContaining('Shop '), distributor_name: expect.stringContaining('Biz '), item_count: 1 });
    const detail = (await request(app).get(`/api/v1/orders/${page1.orders[0].id}`).set(auth(d.token)).expect(200)).body;
    expect(detail).toMatchObject({ retailer_name: page1.orders[0].retailer_name, item_count: 1 });
  });

  it('pages conversations', async () => {
    const d = await reg('distributor');
    for (let i = 0; i < 3; i++) await link(d, await reg('retailer'));
    const all = (await request(app).get('/api/v1/chat/conversations').set(auth(d.token)).expect(200)).body;
    expect(all.conversations).toHaveLength(3);
    const part = (await request(app).get('/api/v1/chat/conversations?limit=2&offset=2').set(auth(d.token)).expect(200)).body;
    expect(part.conversations).toHaveLength(1);
  });
});
