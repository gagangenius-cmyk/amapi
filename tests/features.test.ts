import { AddressInfo } from 'net';
import { createServer, Server as HttpServer } from 'http';
import { io as connect } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';
import { signAccess } from '../src/middleware/auth';
import { attachSocket } from '../src/modules/chat/chat.routes';
import { testOutbox } from '../src/services/mailer';

const app = createApp();
let n = 0;
const phone = () => String(8000000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let http: HttpServer;
let base: string;

async function reg(role: 'distributor' | 'retailer', extra: object = {}) {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
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

async function linked() {
  const d = await reg('distributor');
  const r = await reg('retailer');
  await link(d, r);
  return { d, r };
}

beforeAll(async () => {
  process.env.OTP_DEV_ECHO = '1';
  await migrate(true);
  http = createServer(app);
  await attachSocket(http);
  await new Promise<void>((res) => http.listen(0, res));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { http.close(); await pool.end(); });

describe('OTP by email (Nodemailer)', () => {
  const lastMailTo = (to: string) => [...testOutbox].reverse().find((m) => m.to === to);
  const codeFrom = (m: { text: string } | undefined) => m?.text.match(/\b(\d{6})\b/)?.[1] as string;

  it('emails a code, logs in with it (by email or phone), single-use, and never reveals unknown accounts', async () => {
    const u = await reg('retailer');
    const r1 = await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'login' }).expect(202);
    const mail = lastMailTo(u.email)!;
    expect(mail.subject).toContain('AAYME verification code');
    const code = codeFrom(mail);
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.html).toContain(code);
    expect(r1.body.dev_code).toBe(code); // dev echo only because OTP_DEV_ECHO=1 in tests
    const wrong = code === '000000' ? '111111' : '000000';
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'login', code: wrong }).expect(401);
    const ok = await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email.toUpperCase(), purpose: 'login', code }).expect(200);
    expect(ok.body.access_token).toBeTruthy();
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'login', code }).expect(401); // reuse

    // asking by phone number still mails the code to the account's email
    const before = testOutbox.length;
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.phone, purpose: 'login' }).expect(202);
    expect(testOutbox.length).toBe(before + 1);
    expect(testOutbox[testOutbox.length - 1].to).toBe(u.email);
    const viaPhone = await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.phone, purpose: 'login', code: codeFrom(testOutbox[testOutbox.length - 1]) }).expect(200);
    expect(viaPhone.body.id).toBe(u.id);

    const n0 = testOutbox.length;
    const unknown = await request(app).post('/api/v1/auth/otp/request').send({ identifier: 'nobody@nowhere.test', purpose: 'login' }).expect(202);
    expect(unknown.body.dev_code).toBeUndefined();
    expect(testOutbox.length).toBe(n0); // nothing is mailed, and the response gives no hint
  });

  it('locks a code after 5 wrong attempts and rate-limits requests', async () => {
    const u = await reg('retailer');
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'login' });
    const code = codeFrom(lastMailTo(u.email));
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'login', code: wrong }).expect(401);
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'login', code }).expect(401);
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'login' }).expect(202);
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'login' }).expect(202);
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'login' }).expect(429);
  });

  it('resets password with an emailed code and revokes old sessions', async () => {
    const u = await reg('retailer');
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: u.email, purpose: 'reset' });
    const code = codeFrom(lastMailTo(u.email));
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'reset', code }).expect(400); // needs new_password
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: u.email, purpose: 'reset', code, new_password: 'brandnewpass1' }).expect(200);
    await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: 'password123' }).expect(401);
    await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: 'brandnewpass1' }).expect(200);
  });

  it('requires a unique valid email at registration and lets older accounts add one', async () => {
    const a = await reg('retailer');
    const reg2 = (e: string) => request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: phone(), email: e, name: 'Dup', password: 'password123', shop_name: 'Dup shop', pincode: '400001' });
    // an address nobody has confirmed cannot be held hostage: the newer sign-up takes it over
    const stolen = await reg2(a.email.toUpperCase());
    expect(stolen.status).toBe(201);
    expect((await q1<any>(pool, 'SELECT email FROM users WHERE id = ?', [a.id]))!.email).toBeNull();
    // once confirmed (here: by completing an emailed-code sign-in) it is protected
    const b2 = await reg('retailer');
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: b2.email, purpose: 'login' });
    await request(app).post('/api/v1/auth/otp/verify').send({ identifier: b2.email, purpose: 'login', code: codeFrom(lastMailTo(b2.email)) }).expect(200);
    const dup = await reg2(b2.email);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: phone(), name: 'No mail', password: 'password123', shop_name: 'S', pincode: '400001' }).expect(400);
    await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: phone(), email: 'not-an-email', name: 'Bad', password: 'password123', shop_name: 'S', pincode: '400001' }).expect(400);

    // an account without an email (older data) gets nothing mailed, then adds one with its password
    const bare = await reg('retailer');
    await pool.query('UPDATE users SET email = NULL WHERE id = ?', [bare.id]);
    const n0 = testOutbox.length;
    const r = await request(app).post('/api/v1/auth/otp/request').send({ identifier: bare.phone, purpose: 'login' }).expect(202);
    expect(testOutbox.length).toBe(n0);
    expect(r.body.dev_code).toBeUndefined();
    await request(app).put('/api/v1/me/email').set(auth(bare.token)).send({ email: 'fresh@test.local', password: 'wrong-pass1' }).expect(401);
    await request(app).put('/api/v1/me/email').set(auth(bare.token)).send({ email: b2.email, password: 'password123' }).expect(409);
    await request(app).put('/api/v1/me/email').set(auth(bare.token)).send({ email: 'Fresh@Test.Local', password: 'password123' }).expect(200);
    await request(app).post('/api/v1/auth/otp/request').send({ identifier: bare.phone, purpose: 'login' }).expect(202);
    expect(testOutbox[testOutbox.length - 1].to).toBe('fresh@test.local');
  });
});

describe('UPI payments', () => {
  it('stays pending until the distributor confirms, then posts to the ledger exactly once', async () => {
    const { d, r } = await linked();
    await request(app).get(`/api/v1/payments/pay-info/${d.id}`).set(auth(r.token)).expect(409); // no UPI yet
    await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ bank_account_details: { account_name: 'Biz', account_no: '123456789012', ifsc: 'HDFC0001234', upi_id: 'biz@okhdfc' } }).expect(200);
    const info = await request(app).get(`/api/v1/payments/pay-info/${d.id}`).query({ amount: '250.50' }).set(auth(r.token)).expect(200);
    expect(info.body.upi_uri).toContain('pa=biz%40okhdfc');
    expect(info.body.upi_uri).toContain('am=250.50');

    const body = { distributor_id: d.id, amount: '250.50', utr: '412345678901' };
    const p = await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'p1').send(body).expect(201);
    const replay = await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'p1').send(body).expect(200);
    expect(replay.body.payment.id).toBe(p.body.payment.id);
    await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'p2').send(body).expect(409); // same UTR
    await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'p3').send({ ...body, utr: 'bad' }).expect(400);

    let st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token));
    expect(st.body.balance_due).toBe('0.00'); // not yet

    await request(app).post(`/api/v1/payments/${p.body.payment.id}/confirm`).set(auth(r.token)).expect(403);
    await request(app).post(`/api/v1/payments/${p.body.payment.id}/confirm`).set(auth(d.token)).expect(200);
    const again = await request(app).post(`/api/v1/payments/${p.body.payment.id}/confirm`).set(auth(d.token)).expect(200);
    expect(again.body.replayed).toBe(true);
    await request(app).post(`/api/v1/payments/${p.body.payment.id}/reject`).set(auth(d.token)).expect(409);

    st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token));
    expect(st.body.balance_due).toBe('-250.50'); // advance credit
    expect(st.body.transactions).toHaveLength(1);
    expect(st.body.transactions[0].type).toBe('payment_online');

    const other = await reg('distributor');
    await request(app).post(`/api/v1/payments/${p.body.payment.id}/confirm`).set(auth(other.token)).expect(404);
  });

  it('rejected payments never move the balance', async () => {
    const { d, r } = await linked();
    const p = await request(app).post('/api/v1/payments').set(auth(r.token)).set('Idempotency-Key', 'z1').send({ distributor_id: d.id, amount: '10', utr: 'ABCDEFGH12' }).expect(201);
    await request(app).post(`/api/v1/payments/${p.body.payment.id}/reject`).set(auth(d.token)).expect(200);
    const st = await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token));
    expect(st.body.balance_due).toBe('0.00');
    const list = await request(app).get('/api/v1/payments').set(auth(d.token)).expect(200);
    expect(list.body.payments[0].status).toBe('rejected');
  });
});

describe('chat', () => {
  it('delivers over sockets to the right people only, persists, dedupes and tracks unread', async () => {
    const { d, r } = await linked();
    const stranger = await reg('retailer');
    const connectAs = (token: string) => new Promise<any>((res, rej) => {
      const s = connect(base, { auth: { token }, transports: ['websocket'] });
      s.on('connect', () => res(s)); s.on('connect_error', rej);
    });
    const sd = await connectAs(d.token);
    const sr = await connectAs(r.token);
    const ss = await connectAs(stranger.token);
    const got: Record<string, any[]> = { d: [], r: [], s: [] };
    sd.on('message:new', (m: any) => got.d.push(m));
    sr.on('message:new', (m: any) => got.r.push(m));
    ss.on('message:new', (m: any) => got.s.push(m));

    const ack = await sr.timeout(5000).emitWithAck('message:send', { distributor_id: d.id, body: 'Need 10 bags rice', client_id: 'c-1' });
    expect(ack.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(got.d.map((m) => m.body)).toEqual(['Need 10 bags rice']);
    expect(got.r).toHaveLength(1);
    expect(got.s).toHaveLength(0);

    // retry with the same client_id does not duplicate
    const dup = await request(app).post('/api/v1/chat/messages').set(auth(r.token)).send({ distributor_id: d.id, body: 'Need 10 bags rice', client_id: 'c-1' }).expect(200);
    expect(dup.body.replayed).toBe(true);

    // a retailer cannot post into someone else's conversation
    const bad = await ss.timeout(5000).emitWithAck('message:send', { distributor_id: d.id, body: 'hi' });
    expect(bad.ok).toBe(false);

    const convs = await request(app).get('/api/v1/chat/conversations').set(auth(d.token)).expect(200);
    expect(convs.body.conversations[0]).toMatchObject({ retailer_id: r.id, unread: 1, last_body: 'Need 10 bags rice' });
    const hist = await request(app).get('/api/v1/chat/messages').query({ retailer_id: r.id }).set(auth(d.token)).expect(200);
    expect(hist.body.messages).toHaveLength(1);
    const after = await request(app).get('/api/v1/chat/conversations').set(auth(d.token));
    expect(after.body.conversations[0].unread).toBe(0);

    await request(app).get('/api/v1/chat/messages').query({ distributor_id: d.id }).set(auth(stranger.token)).expect(404);
    expect(() => connect(base, { auth: { token: 'junk' } })).not.toThrow();
    [sd, sr, ss].forEach((s) => s.close());
  });

  it('honors the chat_enabled flag', async () => {
    const { d, r } = await linked();
    const admin = (await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin', ?, 'A', 'x')", [phone()])).insertId;
    const tok = signAccess({ userId: admin, role: 'admin' });
    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(tok)).send({ permissions: { chat_enabled: false } }).expect(200);
    await request(app).post('/api/v1/chat/messages').set(auth(r.token)).send({ distributor_id: d.id, body: 'hello' }).expect(403);
  });
});

describe('admin + devices + docs', () => {
  it('lists distributors for admins only, stores push tokens, serves docs', async () => {
    const d = await reg('distributor');
    const adminId = (await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin', ?, 'A', 'x')", [phone()])).insertId;
    const tok = signAccess({ userId: adminId, role: 'admin' });
    const list = await request(app).get('/api/v1/admin/distributors').set(auth(tok)).expect(200);
    expect(list.body.distributors.some((x: any) => x.id === d.id)).toBe(true);
    await request(app).get('/api/v1/admin/distributors').set(auth(d.token)).expect(403);
    await request(app).get('/api/v1/admin/commissions').set(auth(tok)).expect(200);

    await request(app).post('/api/v1/devices').set(auth(d.token)).send({ token: 'ExponentPushToken[abcdefghij]', platform: 'android' }).expect(204);
    await request(app).post('/api/v1/devices').set(auth(d.token)).send({ token: 'ExponentPushToken[abcdefghij]' }).expect(204); // idempotent
    expect((await q1<any>(pool, 'SELECT COUNT(*) n FROM push_tokens WHERE user_id = ?', [d.id]))!.n).toBe(1);

    const spec = await request(app).get('/openapi.json').expect(200);
    expect(spec.body.paths['/orders'].post.parameters.some((p: any) => p.name === 'Idempotency-Key')).toBe(true);
    await request(app).get('/docs').expect(200);
  });
});
