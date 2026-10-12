import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q, q1 } from '../src/db/pool';
import { checkReceipts, flushOutbox, notifyUsers, setPushTransport, Ticket, Transport } from '../src/services/notify';

const app = createApp();
let n = 0;
const phone = () => String(7900000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
const device = async (u: { id: number; token: string }) => {
  const token = `ExponentPushToken[${u.id}-${Math.random().toString(36).slice(2)}]`;
  await request(app).post('/api/v1/devices').set(auth(u.token)).send({ token }).expect(204);
  return token;
};

/** A fake Expo whose answers each test controls. */
function fake(ticket: (to: string, call: number) => Ticket | 'throw' = () => ({ status: 'ok', id: 'T' + Math.random().toString(36).slice(2) })) {
  const sent: string[] = []; let call = 0; const receipts: Record<string, any> = {};
  const t: Transport = {
    async send(msgs) {
      call++;
      const out = msgs.map((m) => ticket(m.to, call));
      if (out.includes('throw')) throw new Error('network down');
      msgs.forEach((m) => sent.push(m.to));
      return out as Ticket[];
    },
    async receipts(ids) { return Object.fromEntries(ids.filter((i) => receipts[i]).map((i) => [i, receipts[i]])); },
  };
  setPushTransport(t);
  return { sent, receipts, calls: () => call };
}
const row = (token: string) => q1<any>(pool, 'SELECT * FROM push_outbox WHERE token = ? ORDER BY id DESC LIMIT 1', [token]);
async function untilAttempted(token: string) { for (let i = 0; i < 100; i++) { const r = await row(token); if (r && (r.attempts > 0 || r.status !== 'pending')) return r; await sleep(30); } throw new Error('never attempted'); }

beforeAll(async () => { await migrate(true); });
afterEach(() => setPushTransport(null));
afterAll(async () => { await pool.end(); });

describe('push queue', () => {
  it('stores, sends and records the ticket; delivery is confirmed by the receipt later', async () => {
    const u = await reg('retailer'); const tok = await device(u);
    const f = fake((to) => ({ status: 'ok', id: 'TICKET-1' }));
    await notifyUsers([u.id], 'Hello', 'World', { type: 'x' });
    const r = await untilAttempted(tok);
    expect(f.sent).toEqual([tok]);
    expect(r).toMatchObject({ status: 'sent', ticket_id: 'TICKET-1', title: 'Hello' });
    f.receipts['TICKET-1'] = { status: 'ok' };
    expect(await checkReceipts(0)).toBe(1);
    expect((await row(tok)).status).toBe('delivered');
    expect(await checkReceipts(0)).toBe(0);                      // already settled
  });

  it('retries with growing delays when Expo is unreachable, and gives up after six tries', async () => {
    const u = await reg('retailer'); const tok = await device(u);
    fake(() => 'throw');
    await notifyUsers([u.id], 'Retry', 'me');
    let r = await untilAttempted(tok);
    expect(r).toMatchObject({ status: 'pending', attempts: 1 });
    expect(+new Date(r.next_attempt_at) - Date.now()).toBeGreaterThan(30_000);       // not immediately again
    expect(await flushOutbox(200, new Date())).toBe(0);                              // not due yet
    let t = Date.now();
    for (let i = 2; i <= 6; i++) { t += 3600_000; await flushOutbox(200, new Date(t)); }
    r = await row(tok);
    expect(r).toMatchObject({ status: 'failed', attempts: 6 });
    expect(r.error).toContain('network down');
  });

  it('a transient failure followed by recovery still delivers exactly once', async () => {
    const u = await reg('retailer'); const tok = await device(u);
    const f = fake((_to, call) => (call === 1 ? 'throw' : { status: 'ok', id: 'T9' }));
    await notifyUsers([u.id], 'Eventually', 'ok');
    await untilAttempted(tok);
    await flushOutbox(200, new Date(Date.now() + 3600_000));
    expect((await row(tok)).status).toBe('sent');
    expect(f.sent).toEqual([tok]);
    await flushOutbox(200, new Date(Date.now() + 7200_000));
    expect(f.sent).toHaveLength(1);
  });

  it('forgets a device Expo says no longer exists', async () => {
    const u = await reg('retailer'); const tok = await device(u);
    fake(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' }, message: 'gone' }));
    await notifyUsers([u.id], 'x', 'y');
    expect((await untilAttempted(tok)).status).toBe('dead');
    expect(await q1(pool, 'SELECT 1 FROM push_tokens WHERE token = ?', [tok])).toBeUndefined();
  });

  it('a bad receipt marks the message failed and drops a dead token', async () => {
    const u = await reg('retailer'); const tok = await device(u);
    const f = fake(() => ({ status: 'ok', id: 'T-bad' }));
    await notifyUsers([u.id], 'x', 'y'); await untilAttempted(tok);
    f.receipts['T-bad'] = { status: 'error', message: 'rejected by FCM', details: { error: 'DeviceNotRegistered' } };
    await checkReceipts(0);
    expect((await row(tok)).status).toBe('dead');
    expect(await q1(pool, 'SELECT 1 FROM push_tokens WHERE token = ?', [tok])).toBeUndefined();
  });

  it('two servers flushing at once never send the same message twice', async () => {
    const u = await reg('retailer'); const tok = await device(u);
    // enqueue without the automatic flush: insert the row by hand
    await exec(pool, "INSERT INTO push_outbox (user_id, token, title, body, next_attempt_at) VALUES (?,?,?,?,?)", [u.id, tok, 'a', 'b', new Date()]);
    const f = fake();
    await Promise.all([flushOutbox(), flushOutbox(), flushOutbox()]);
    await sleep(100);
    expect(f.sent.filter((x) => x === tok)).toHaveLength(1);
  });

  it('real events (a new order) produce a queued push for the distributor team', async () => {
    const d = await reg('distributor'); const r = await reg('retailer'); const tok = await device(d);
    fake();
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'X', price: '10', stock_qty: 5 })).body.id;
    await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'push-1').send({ distributor_id: d.id, items: [{ product_id: pid, qty: 1 }] }).expect(201);
    let queued: any;
    for (let i = 0; i < 100 && !queued; i++) { queued = await q1<any>(pool, "SELECT * FROM push_outbox WHERE token = ? AND title = 'New order' AND status = 'sent'", [tok]); if (!queued) await sleep(30); }
    expect(queued).toBeTruthy();
  });

  it('does nothing for users without a registered device', async () => {
    const u = await reg('retailer');
    fake();
    await notifyUsers([u.id], 'x', 'y');
    expect((await q<any>(pool, 'SELECT id FROM push_outbox WHERE user_id = ?', [u.id]))).toHaveLength(0);
  });
});

describe('chat read receipts', () => {
  it('the sender can tell when the other side has seen a message', async () => {
    const d = await reg('distributor'); const r = await reg('retailer');
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    const sent = (await request(app).post('/api/v1/chat/messages').set(auth(r.token)).send({ distributor_id: d.id, body: 'Is rice in stock?', client_id: 'c1' }).expect(201)).body.message;

    const mine = () => request(app).get('/api/v1/chat/messages').query({ distributor_id: d.id }).set(auth(r.token));
    expect((await mine()).body.peer_last_read_id).toBe(0);                       // sent, not seen
    await request(app).get('/api/v1/chat/messages').query({ retailer_id: r.id }).set(auth(d.token)).expect(200);   // distributor opens the chat
    expect((await mine()).body.peer_last_read_id).toBe(sent.id);                 // now seen

    const reply = (await request(app).post('/api/v1/chat/messages').set(auth(d.token)).send({ retailer_id: r.id, body: 'Yes', client_id: 'c2' }).expect(201)).body.message;
    const theirs = (await request(app).get('/api/v1/chat/messages').query({ retailer_id: r.id }).set(auth(d.token))).body;
    expect(theirs.peer_last_read_id).toBe(sent.id);                              // retailer has not read the reply yet
    await mine();
    expect((await request(app).get('/api/v1/chat/messages').query({ retailer_id: r.id }).set(auth(d.token))).body.peer_last_read_id).toBe(reply.id);
  });
});
