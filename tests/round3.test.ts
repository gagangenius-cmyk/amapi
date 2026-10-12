import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { exec, pool, q, q1 } from '../src/db/pool';
import * as totp from '../src/utils/totp';

const app = createApp();
let n = 0;
const phone = () => String(7700000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const step = () => Math.floor(Date.now() / 30000);

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body);
  expect(r.status).toBe(201);
  return { id: r.body.id as number, token: r.body.access_token as string, refresh: r.body.refresh_token as string, phone: p };
}
async function admin() {
  const p = phone();
  const r = await exec(pool, "INSERT INTO users (role, phone, name, email, password_hash) VALUES ('admin',?,?,?,?)", [p, 'Root', `a${p}@test.local`, await bcrypt.hash('password123', 4)]);
  const l = await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200);
  return { id: r.insertId, phone: p, token: l.body.access_token as string };
}
async function setup(stock = 20) {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', stock_qty: stock })).body.id as number;
  return { d, r, pid };
}
let k = 0;
const order = (r: { token: string }, did: number, items: { product_id: number; qty: number }[]) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'r3-' + ++k).send({ distributor_id: did, items });
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('self-updating schema', () => {
  it('can be run again, even by two instances at once, and finds nothing left to do', async () => {
    await Promise.all([migrate(), migrate()]);
    const names = (await q<any>(pool, 'SELECT name FROM schema_migrations')).map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('008_enterprise_round3.sql');
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 test vector', () => {
    // secret "12345678901234567890", T = 59 s  =>  94287082 (8 digits) => 287082 (last 6)
    expect(totp.codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
    expect(totp.verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 59_000)).toBe(1);
    expect(totp.verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 200_000)).toBeNull();
  });
  it('seals secrets so they are not readable in the database', () => {
    const s = totp.newSecret();
    expect(totp.open(totp.seal(s))).toBe(s);
    expect(totp.seal(s)).not.toContain(s);
  });
});

describe('admin two-factor', () => {
  it('turns on with a valid code, then every sign-in needs a fresh one', async () => {
    const a = await admin();
    const { body } = await request(app).post('/api/v1/auth/2fa/setup').set(auth(a.token)).expect(200);
    await request(app).post('/api/v1/auth/2fa/enable').set(auth(a.token)).send({ code: '000000' }).expect(401);
    await request(app).post('/api/v1/auth/2fa/enable').set(auth(a.token)).send({ code: totp.codeAt(body.secret, step()) }).expect(200);
    expect((await request(app).get('/api/v1/me').set(auth(a.token))).body.two_factor).toBe(true);
    // the stored secret is encrypted
    expect((await q1<any>(pool, 'SELECT totp_secret FROM users WHERE id = ?', [a.id]))!.totp_secret).not.toContain(body.secret);

    const login = (extra: object = {}) => request(app).post('/api/v1/auth/login').send({ phone: a.phone, password: 'password123', ...extra });
    expect((await login()).body.error.code).toBe('TOTP_REQUIRED');
    expect((await login({ totp: '123456' })).body.error.code).toBe('BAD_TOTP');
    expect((await login({ totp: totp.codeAt(body.secret, step() + 1) })).status).toBe(200);
    // a code works once: the same one again is refused (replay)
    expect((await login({ totp: totp.codeAt(body.secret, step() + 1) })).body.error.code).toBe('BAD_TOTP');
  });

  it('can be required before any admin endpoint works', async () => {
    const a = await admin();
    (env as any).adminRequires2fa = true;
    try {
      const r = await request(app).get('/api/v1/admin/stats').set(auth(a.token));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('TWO_FACTOR_REQUIRED');
      const { body } = await request(app).post('/api/v1/auth/2fa/setup').set(auth(a.token)).expect(200);   // setup itself stays reachable
      await request(app).post('/api/v1/auth/2fa/enable').set(auth(a.token)).send({ code: totp.codeAt(body.secret, step()) }).expect(200);
      await request(app).get('/api/v1/admin/stats').set(auth(a.token)).expect(200);
    } finally { (env as any).adminRequires2fa = false; }
  });

  it('is for admins only', async () => {
    const d = await reg('distributor');
    await request(app).post('/api/v1/auth/2fa/setup').set(auth(d.token)).expect(403);
  });
});

describe('device sessions', () => {
  it('lists sign-ins, signs one out, or all the others', async () => {
    const u = await reg('retailer');
    const signIn = () => request(app).post('/api/v1/auth/login').set('User-Agent', 'TestPhone/1').send({ phone: u.phone, password: 'password123' }).expect(200);
    const second = (await signIn()).body; const third = (await signIn()).body;
    let list = (await request(app).get('/api/v1/me/sessions').set(auth(u.token)).expect(200)).body.sessions;
    expect(list).toHaveLength(3);
    expect(list.some((s: any) => s.device === 'TestPhone/1')).toBe(true);

    // refreshing keeps it the same session (no new row in the list)
    const rotated = (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: second.refresh_token }).expect(200)).body;
    expect((await request(app).get('/api/v1/me/sessions').set(auth(u.token))).body.sessions).toHaveLength(3);

    const mine = await q1<any>(pool, 'SELECT session_id FROM refresh_tokens WHERE token_hash = SHA2(?, 256)', [third.refresh_token]);
    await request(app).delete(`/api/v1/me/sessions/${mine!.session_id}`).set(auth(u.token)).expect(204);
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: third.refresh_token }).expect(401);
    await request(app).delete(`/api/v1/me/sessions/${mine!.session_id}`).set(auth(u.token)).expect(404);

    const out = await request(app).post('/api/v1/me/sessions/revoke-others').set(auth(u.token)).send({ refresh_token: rotated.refresh_token }).expect(200);
    expect(out.body.revoked).toBeGreaterThanOrEqual(1);
    list = (await request(app).get('/api/v1/me/sessions').set(auth(u.token))).body.sessions;
    expect(list).toHaveLength(1);
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: u.refresh }).expect(401);
  });
});

describe('refresh-token theft detection', () => {
  it('a replayed rotated token ends only that session; a signed-out device does not hurt the others', async () => {
    const u = await reg('retailer');
    const login = async () => (await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: 'password123' }).expect(200)).body;
    const a = await login(); const b = await login();
    const a2 = (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: a.refresh_token }).expect(200)).body;
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: a.refresh_token }).expect(401);   // old copy replayed
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: a2.refresh_token }).expect(401);  // so the whole session is ended
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: b.refresh_token }).expect(200);   // the other device is untouched
  });
});

describe('product photos', () => {
  it('uploads, serves, covers and deletes; rejects fakes and strangers', async () => {
    const { d, pid } = await setup(); const other = await reg('distributor');
    const up = (t: string, body: Buffer | string, type = 'image/png', id = pid) => request(app).post(`/api/v1/catalog/${id}/images`).set(auth(t)).set('Content-Type', type).send(body);

    expect((await up(d.token, 'not an image at all, just text')).status).toBe(415);          // wrong bytes
    expect((await up(d.token, Buffer.from('GIF89a-not-allowed-xxxxxxx'), 'image/gif')).status).toBe(415);
    expect((await up(other.token, png())).status).toBe(404);                                    // someone else's product

    const one = await up(d.token, png()); expect(one.status).toBe(201);
    const two = await up(d.token, png()); expect(two.body.images).toHaveLength(2);
    const url = one.body.images[0].url as string;
    const got = await request(app).get(url).expect(200);
    expect(got.headers['content-type']).toContain('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    await request(app).get('/api/v1/media/' + 'f'.repeat(40)).expect(404);
    await request(app).get('/api/v1/media/..%2F..%2F.env').expect(404);

    // shows up on the retailer-facing and distributor-facing product
    expect((await request(app).get(`/api/v1/catalog/${pid}`).set(auth(d.token))).body.product.image_url).toBe(url);

    const second = two.body.images[1].id;
    const cov = await request(app).post(`/api/v1/catalog/${pid}/images/${second}/cover`).set(auth(d.token)).expect(200);
    expect(cov.body.images[0].id).toBe(second);

    for (let i = 0; i < 3; i++) await up(d.token, png()).expect(201);
    expect((await up(d.token, png())).body.error.code).toBe('TOO_MANY_IMAGES');
    const del = await request(app).delete(`/api/v1/catalog/${pid}/images/${second}`).set(auth(d.token)).expect(200);
    expect(del.body.images).toHaveLength(4);
    await request(app).delete(`/api/v1/catalog/${pid}/images/${second}`).set(auth(d.token)).expect(404);
  });
});

describe('partial fulfilment', () => {
  it('accepts fewer than ordered; the invoice, stock and total follow', async () => {
    const { d, r, pid } = await setup(20);
    const oid = (await order(r, d.id, [{ product_id: pid, qty: 5 }]).expect(201)).body.order.id;
    const acc = (items?: any[]) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted', ...(items && { items }) });

    expect((await acc([{ product_id: pid, qty: 6 }])).body.error.code).toBe('QTY_TOO_HIGH');
    expect((await acc([{ product_id: pid, qty: 0 }])).body.error.code).toBe('NOTHING_TO_SHIP');
    expect((await acc([{ product_id: 999999, qty: 1 }])).status).toBe(400);
    expect((await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'rejected', items: [{ product_id: pid, qty: 1 }] })).status).toBe(400);

    const ok = await acc([{ product_id: pid, qty: 3 }]);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ total: '300.00', is_adjusted: true });
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(17);
    expect((await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token))).body.balance_due).toBe('300.00');
    const detail = (await request(app).get(`/api/v1/orders/${oid}`).set(auth(r.token))).body;
    expect(detail.items[0]).toMatchObject({ qty: 3, ordered_qty: 5, line_total: '300.00' });

    // cancelling after a partial acceptance gives back exactly what was taken
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'cancelled' }).expect(200);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [pid]))!.stock_qty).toBe(20);
    expect((await request(app).get('/api/v1/ledger/statement').query({ retailer_id: r.id }).set(auth(d.token))).body.balance_due).toBe('0.00');
  });

  it('a line dropped to zero is not invoiced and can not be returned', async () => {
    const { d, r, pid } = await setup(20);
    const p2 = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Dal', price: '50', stock_qty: 20 })).body.id;
    const oid = (await order(r, d.id, [{ product_id: pid, qty: 2 }, { product_id: p2, qty: 4 }]).expect(201)).body.order.id;
    await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted', items: [{ product_id: p2, qty: 0 }] }).expect(200);
    for (const to of ['dispatched', 'out_for_delivery', 'delivered']) await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to }).expect(200);
    expect((await q1<any>(pool, 'SELECT stock_qty FROM products WHERE id = ?', [p2]))!.stock_qty).toBe(20);
    expect((await request(app).get(`/api/v1/orders/${oid}`).set(auth(r.token))).body.total).toBe('200.00');
    const ret = await request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', 'z1').send({ order_id: oid, reason: 'Wrong', items: [{ product_id: p2, qty: 1 }] });
    expect(ret.body.error.code).toBe('RETURN_TOO_MANY');
    const inv = await request(app).get(`/api/v1/orders/${oid}/invoice-link`).set(auth(r.token)).expect(200);
    const html = (await request(app).get(new URL(inv.body.url, 'http://x').pathname + new URL(inv.body.url, 'http://x').search)).text;
    expect(html).toContain('Rice'); expect(html).not.toContain('Dal');
  });
});

describe('admin console API', () => {
  it('shows platform stats, filters the audit log, searches users and suspends accounts', async () => {
    const a = await admin(); const { d, r } = await setup();
    const stats = (await request(app).get('/api/v1/admin/stats').set(auth(a.token)).expect(200)).body;
    expect(stats.users.retailer.count).toBeGreaterThanOrEqual(1);
    await request(app).get('/api/v1/admin/stats').set(auth(d.token)).expect(403);

    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'wrong-wrong1' }).expect(401);
    const log = (await request(app).get('/api/v1/admin/audit').query({ action: 'auth.login_failed' }).set(auth(a.token)).expect(200)).body;
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.entries.every((e: any) => e.action === 'auth.login_failed')).toBe(true);

    const found = (await request(app).get('/api/v1/admin/users').query({ q: r.phone }).set(auth(a.token))).body.users;
    expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ id: r.id, role: 'retailer', is_active: true });

    await request(app).post(`/api/v1/admin/users/${r.id}/status`).set(auth(a.token)).send({ is_active: false, reason: 'fraud check' }).expect(200);
    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'password123' }).expect(401);
    await request(app).get('/api/v1/me').set(auth(r.token)).expect(401);                       // existing session is cut off too
    await request(app).post('/api/v1/auth/refresh').send({ refresh_token: r.refresh }).expect(401);
    await request(app).post(`/api/v1/admin/users/${r.id}/status`).set(auth(a.token)).send({ is_active: true }).expect(200);
    await request(app).post('/api/v1/auth/login').send({ phone: r.phone, password: 'password123' }).expect(200);

    expect((await request(app).post(`/api/v1/admin/users/${a.id}/status`).set(auth(a.token)).send({ is_active: false })).status).toBe(409);
    expect((await request(app).get('/api/v1/admin/audit').query({ action: 'admin.user_' }).set(auth(a.token))).body.entries).toHaveLength(2);
  });

  it('serves the console as static files that run no inline script', async () => {
    const html = await request(app).get('/admin-console/').expect(200);
    expect(html.text).toContain('AAYME Admin');
    expect(html.text).not.toMatch(/<script>[^<]/);
    const js = await request(app).get('/admin-console/app.js').expect(200);
    expect(js.text).not.toContain('innerHTML');
  });
});
