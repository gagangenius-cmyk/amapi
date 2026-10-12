import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q } from '../src/db/pool';
import { setPushTransport, Transport } from '../src/services/notify';

const app = createApp();
let n = 0;
const phone = () => String(7300000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dist(pins = ['400001']) {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }).expect(201);
  await request(app).put('/api/v1/distributor/pincodes').set(auth(r.body.access_token)).send({ pincodes: pins }).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(r.body.access_token)).send({ name: 'Sugar', price: '40', stock_qty: 10 })).body.id as number;
  return { id: r.body.id as number, token: r.body.access_token as string, pid };
}
async function ret(pincode = '400001') {
  const p = phone();
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'retailer', phone: p, email: `r${p}@t.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode }).expect(201);
  const tok = `ExponentPushToken[ann-${r.body.id}]`;
  await request(app).post('/api/v1/devices').set(auth(r.body.access_token)).send({ token: tok }).expect(204);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p, push: tok };
}
const link = async (d: { token: string; id: number }, r: { token: string; phone: string }) => {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
};
const send = (d: { token: string }, b: object) => request(app).post('/api/v1/announcements').set(auth(d.token)).send({ title: 'Diwali scheme', body: 'Buy 10 get 1 free on sugar this week', ...b });

const delivered: string[] = [];
beforeAll(async () => {
  await migrate(true);
  const t: Transport = { async send(m) { m.forEach((x) => delivered.push(`${x.to}|${x.title}`)); return m.map(() => ({ status: 'ok' as const, id: 'T' })); }, async receipts() { return {}; } };
  setPushTransport(t);
});
afterEach(() => { delivered.length = 0; });
afterAll(async () => { setPushTransport(null); await pool.end(); });

describe('offers and announcements', () => {
  it('reaches connected retailers by push and in the Offers list; others see nothing', async () => {
    const d = await dist(); const a = await ret(); const b = await ret(); const stranger = await ret('110001');
    await link(d, a); await link(d, b);
    const r = await send(d, { product_id: d.pid }).expect(201);
    expect(r.body.recipients).toBe(2);
    for (let i = 0; i < 100 && delivered.filter((x) => x.includes('Diwali')).length < 2; i++) await sleep(30);
    expect(delivered.filter((x) => x.includes('Diwali scheme')).map((x) => x.split('|')[0]).sort()).toEqual([a.push, b.push].sort());
    expect(delivered.some((x) => x.startsWith(stranger.push))).toBe(false);

    const feed = (await request(app).get('/api/v1/announcements').set(auth(a.token)).expect(200)).body;
    expect(feed.unread).toBe(1);
    expect(feed.offers[0]).toMatchObject({ title: 'Diwali scheme', product_name: 'Sugar', connected: true, unread: true });
    expect((await request(app).get('/api/v1/announcements').set(auth(stranger.token))).body.offers).toHaveLength(0);

    await request(app).post('/api/v1/announcements/seen').set(auth(a.token)).expect(204);
    const after = (await request(app).get('/api/v1/announcements').set(auth(a.token))).body;
    expect(after.unread).toBe(0); expect(after.offers[0].unread).toBe(false);

    const mine = (await request(app).get('/api/v1/announcements').set(auth(d.token))).body.announcements;
    expect(mine[0]).toMatchObject({ title: 'Diwali scheme', recipients: 2, audience: 'all' });
  });

  it('pincode offers go to that pincode only, including unconnected retailers there', async () => {
    const d = await dist(['400001', '400002']);
    const linkedIn = await ret('400001'); const linkedOut = await ret('400002'); const nearUnlinked = await ret('400002'); const farUnlinked = await ret('560001');
    await link(d, linkedIn); await link(d, linkedOut);
    const count = (await request(app).get('/api/v1/announcements/audience').query({ audience: 'pincodes', pincodes: '400002' }).set(auth(d.token))).body.recipients;
    expect(count).toBe(2);                                                    // the connected one + the unconnected one in 400002
    expect((await send(d, { audience: 'pincodes', pincodes: ['400002'] })).body.recipients).toBe(2);
    expect((await request(app).get('/api/v1/announcements').set(auth(linkedOut.token))).body.offers).toHaveLength(1);
    expect((await request(app).get('/api/v1/announcements').set(auth(nearUnlinked.token))).body.offers).toHaveLength(1);
    expect((await request(app).get('/api/v1/announcements').set(auth(linkedIn.token))).body.offers).toHaveLength(0);   // connected but other pincode
    expect((await request(app).get('/api/v1/announcements').set(auth(farUnlinked.token))).body.offers).toHaveLength(0);
    // a pincode the distributor does not sell to reaches only its connected retailers there (nobody)
    expect((await send(d, { audience: 'pincodes', pincodes: ['999999'] })).body.recipients).toBe(0);
  });

  it('respects the notifications switch, daily limit, expiry and ownership', async () => {
    const d = await dist(); const r = await ret(); await link(d, r);
    const bcrypt = await import('bcryptjs');
    const ap = phone(); await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [ap, 'A', await bcrypt.hash('password123', 4)]);
    const admin = (await request(app).post('/api/v1/auth/login').send({ phone: ap, password: 'password123' })).body.access_token;

    expect((await send(d, { title: 'x' })).status).toBe(400);
    expect((await send(d, { audience: 'pincodes' })).status).toBe(400);                              // pincodes needed
    expect((await send(d, { product_id: 999999 })).status).toBe(400);
    expect((await request(app).post('/api/v1/announcements').set(auth(r.token)).send({ title: 'abc', body: 'abc' })).status).toBe(403);   // retailers can not send

    await send(d, { valid_until: '2020-01-01', title: 'Old news' }).expect(201);
    expect((await request(app).get('/api/v1/announcements').set(auth(r.token))).body.offers.map((o: any) => o.title)).not.toContain('Old news');   // expired

    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(admin)).send({ permissions: { notifications_enabled: false } }).expect(200);
    expect((await send(d, {})).status).toBe(403);
    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(admin)).send({ permissions: { notifications_enabled: true } }).expect(200);

    for (let i = 0; i < 8; i++) await send(d, { title: 'Offer ' + i }).expect(201);                  // 1 old + 8 = 9 so far
    await send(d, { title: 'Tenth' }).expect(201);
    expect((await send(d, { title: 'Eleventh' })).status).toBe(429);

    const id = (await q<any>(pool, 'SELECT id FROM announcements WHERE distributor_id = ? LIMIT 1', [d.id]))[0].id;
    const other = await dist();
    await request(app).delete(`/api/v1/announcements/${id}`).set(auth(other.token)).expect(404);
    await request(app).delete(`/api/v1/announcements/${id}`).set(auth(d.token)).expect(204);
  });

  it('turning "sell by pincode" off keeps offers away from unconnected retailers', async () => {
    const d = await dist(); const near = await ret();
    const bcrypt = await import('bcryptjs');
    const ap = phone(); await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [ap, 'A2', await bcrypt.hash('password123', 4)]);
    const admin = (await request(app).post('/api/v1/auth/login').send({ phone: ap, password: 'password123' })).body.access_token;
    await request(app).put(`/api/v1/distributor/${d.id}/admin`).set(auth(admin)).send({ permissions: { pincode_selling: false } }).expect(200);
    expect((await send(d, { audience: 'pincodes', pincodes: ['400001'] })).body.recipients).toBe(0);
    expect((await request(app).get('/api/v1/announcements').set(auth(near.token))).body.offers).toHaveLength(0);
  });
});
