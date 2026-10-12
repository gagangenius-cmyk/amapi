import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool, q1 } from '../src/db/pool';
import { effectiveTable, resolvePrice, Rule } from '../src/modules/pricing/resolver';

const app = createApp();
let n = 0;
const phone = () => String(7700000000 + 800000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// ---- the rules, on their own -------------------------------------------------------------------
const rule = (o: Partial<Rule> & { list_id: number }): Rule => ({ list_name: 'L' + o.list_id, kind: 'group', priority: 0, allow_above: false, mode: 'fixed', value: 8000, min_qty: 1, ...o });
const tiers = [{ min_qty: 10, price_paise: 9000 }, { min_qty: 50, price_paise: 8500 }];

describe('price precedence (pure)', () => {
  it('uses the standard price and the quantity break when no list applies', () => {
    expect(resolvePrice(10000, tiers, [], 1)).toMatchObject({ unit_paise: 10000, basis: 'standard', list_id: null });
    expect(resolvePrice(10000, tiers, [], 10)).toMatchObject({ unit_paise: 9000, basis: 'tier' });
    expect(resolvePrice(10000, tiers, [], 60)).toMatchObject({ unit_paise: 8500, basis: 'tier' });
  });

  it('a fixed list price replaces the standard price', () => {
    expect(resolvePrice(10000, [], [rule({ list_id: 1, value: 7500 })], 1)).toMatchObject({ unit_paise: 7500, basis: 'list', list_id: 1 });
  });

  it('a percentage comes off the standard price for that quantity, so it builds on the break', () => {
    const r = [rule({ list_id: 1, mode: 'percent_off', value: 1000 })];            // 10% off
    expect(resolvePrice(10000, tiers, r, 1).unit_paise).toBe(9000);
    expect(resolvePrice(10000, tiers, r, 10).unit_paise).toBe(8100);               // 10% off the 9000 break
    expect(resolvePrice(10000, tiers, r, 50).unit_paise).toBe(7650);
  });

  it('a more specific kind always beats a less specific one, even when the other is cheaper', () => {
    const r = [
      rule({ list_id: 1, kind: 'regional', value: 5000 }),
      rule({ list_id: 2, kind: 'group', value: 6000 }),
      rule({ list_id: 3, kind: 'promotion', value: 7000 }),
      rule({ list_id: 4, kind: 'contract', value: 9000 }),
    ];
    const out = resolvePrice(10000, [], r, 1);
    expect(out).toMatchObject({ unit_paise: 9000, list_id: 4, kind: 'contract' });
    expect(out.considered.map((c) => c.kind)).toEqual(['contract', 'promotion', 'group', 'regional']);
    expect(resolvePrice(10000, [], r.slice(0, 3), 1)).toMatchObject({ list_id: 3 });
    expect(resolvePrice(10000, [], r.slice(0, 2), 1)).toMatchObject({ list_id: 2 });
  });

  it('within one kind the higher priority wins, then the lower price, then the lower list id', () => {
    expect(resolvePrice(10000, [], [rule({ list_id: 1, priority: 1, value: 5000 }), rule({ list_id: 2, priority: 5, value: 9000 })], 1).list_id).toBe(2);
    expect(resolvePrice(10000, [], [rule({ list_id: 1, value: 8000 }), rule({ list_id: 2, value: 7000 })], 1).list_id).toBe(2);
    expect(resolvePrice(10000, [], [rule({ list_id: 9, value: 7000 }), rule({ list_id: 3, value: 7000 })], 1).list_id).toBe(3);
    // and the answer does not depend on the order the rows arrived in
    const a = [rule({ list_id: 1, value: 7000 }), rule({ list_id: 2, value: 7000 })];
    expect(resolvePrice(10000, [], a, 1).list_id).toBe(resolvePrice(10000, [], [...a].reverse(), 1).list_id);
  });

  it('prices never stack: only the winner applies', () => {
    const r = [rule({ list_id: 1, kind: 'contract', mode: 'percent_off', value: 1000 }), rule({ list_id: 2, kind: 'promotion', mode: 'percent_off', value: 2000 })];
    expect(resolvePrice(10000, [], r, 1).unit_paise).toBe(9000);   // not 10000 x 0.9 x 0.8
  });

  it('inside a list, the row with the largest minimum quantity that is reached applies', () => {
    const r = [rule({ list_id: 1, value: 9000, min_qty: 1 }), rule({ list_id: 1, value: 8000, min_qty: 20 }), rule({ list_id: 1, value: 7000, min_qty: 100 })];
    expect([1, 19, 20, 99, 100, 500].map((q) => resolvePrice(10000, [], r, q).unit_paise)).toEqual([9000, 9000, 8000, 8000, 7000, 7000]);
  });

  it('a list price above the standard price is capped, unless the list allows it', () => {
    const above = rule({ list_id: 1, value: 12000 });
    expect(resolvePrice(10000, [], [above], 1)).toMatchObject({ unit_paise: 10000, basis: 'standard', list_id: null });
    expect(resolvePrice(10000, [], [above], 1).considered[0]).toMatchObject({ capped: true });
    expect(resolvePrice(10000, [], [{ ...above, allow_above: true }], 1)).toMatchObject({ unit_paise: 12000, basis: 'list' });
  });

  it('builds the retailer\'s whole price table with a break wherever the price changes', () => {
    const r = [rule({ list_id: 1, kind: 'contract', value: 8800, min_qty: 1 }), rule({ list_id: 1, kind: 'contract', value: 8000, min_qty: 25 })];
    const t = effectiveTable(10000, tiers, r);
    expect(t.base.unit_paise).toBe(8800);
    // standard break at 10 (9000) is worse than 8800, so it is capped to the contract price: no break; 25 -> 8000; 50 (standard 8500) -> still 8000
    expect(t.breaks.map((b) => [b.min_qty, b.resolved.unit_paise])).toEqual([[25, 8000]]);
  });
});

// ---- through the API ---------------------------------------------------------------------------
async function reg(role: 'distributor' | 'retailer', pincode = '400001') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + p, pincode };
  const r = (await request(app).post('/api/v1/auth/register').send(body).expect(201)).body;
  return { id: r.id as number, token: r.access_token as string, phone: p };
}
const link = async (d: { id: number; token: string }, r: { phone: string; token: string }) => {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
};
async function setup() {
  const d = await reg('distributor'); const r = await reg('retailer'); const other = await reg('retailer');
  await link(d, r); await link(d, other);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({
    name: 'Rice', price: '100', stock_qty: 500, gst_rate_bps: 0, tiers: [{ min_qty: 10, price: '90' }],
  })).body.id as number;
  const list = async (body: object) => (await request(app).post('/api/v1/pricing/lists').set(auth(d.token)).send(body).expect(201)).body;
  const item = (id: number, body: object) => request(app).post(`/api/v1/pricing/lists/${id}/items`).set(auth(d.token)).send(body).expect(201);
  const members = (id: number, ids: number[]) => request(app).put(`/api/v1/pricing/lists/${id}/members`).set(auth(d.token)).send({ retailer_ids: ids }).expect(200);
  return { d, r, other, pid, list, item, members };
}
let k = 0;
const place = (r: { token: string }, did: number, pid: number, qty: number) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'pl' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty }] });
const quote = async (s: Awaited<ReturnType<typeof setup>>, retailer: number, qty = 1, date?: string) =>
  (await request(app).get('/api/v1/pricing/quote').query({ retailer_id: retailer, product_id: s.pid, qty, ...(date ? { date } : {}) }).set(auth(s.d.token)).expect(200)).body;
const today = () => new Date().toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('customer price lists', () => {
  it('a contract price applies to its member only, on quotes, the storefront and the order', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Acme contract', kind: 'contract' });
    await s.item(l.id, { product_id: s.pid, price: '80' });
    await s.members(l.id, [s.r.id]);

    expect(await quote(s, s.r.id)).toMatchObject({ unit_price: '80.00', standard_price: '100.00', basis: 'list', applied: { name: 'Acme contract', kind: 'contract' } });
    expect(await quote(s, s.other.id)).toMatchObject({ unit_price: '100.00', basis: 'standard', applied: null });

    // the member's storefront shows the contract price; the other retailer's does not
    const mine = (await request(app).get(`/api/v1/retailer/stores/${s.d.id}/products`).set(auth(s.r.token)).expect(200)).body.products.find((x: any) => x.id === s.pid);
    expect(mine).toMatchObject({ price: '80.00', price_note: 'Your price: Acme contract' });
    const theirs = (await request(app).get(`/api/v1/retailer/stores/${s.d.id}/products`).set(auth(s.other.token)).expect(200)).body.products.find((x: any) => x.id === s.pid);
    expect(theirs.price).toBe('100.00');
    expect(theirs.price_note).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain('Acme');

    // and the order is priced at exactly what the storefront showed
    const o = (await place(s.r, s.d.id, s.pid, 3).expect(201)).body.order;
    expect(o.items[0]).toMatchObject({ unit_price: '80.00', standard_unit_price: '100.00', price_list: 'Acme contract', price_basis: 'list' });
    expect(o.total).toBe('240.00');
    expect((await place(s.other, s.d.id, s.pid, 3).expect(201)).body.order.total).toBe('300.00');
  });

  it('a percentage builds on the quantity break, and the storefront table matches the order price at every quantity', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Wholesale 10%', kind: 'group' });
    await s.item(l.id, { product_id: s.pid, percent_off: 10 });
    await s.members(l.id, [s.r.id]);

    const p = (await request(app).get(`/api/v1/retailer/stores/${s.d.id}/products`).set(auth(s.r.token)).expect(200)).body.products.find((x: any) => x.id === s.pid);
    expect(p.price).toBe('90.00');
    expect(p.tiers).toEqual([{ min_qty: 10, price: '81.00' }]);
    // what the app would compute from that table equals what the server charges
    const fromTable = (qty: number) => Number([...p.tiers].reverse().find((t: any) => t.min_qty <= qty)?.price ?? p.price);
    for (const qty of [1, 9, 10, 25]) {
      const o = (await place(s.r, s.d.id, s.pid, qty).expect(201)).body.order;
      expect(Number(o.items[0].unit_price), `qty ${qty}`).toBe(fromTable(qty));
    }
  });

  it('a past order keeps its price when the list changes or is removed', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Temp deal', kind: 'contract' });
    await s.item(l.id, { product_id: s.pid, price: '70' });
    await s.members(l.id, [s.r.id]);
    const o = (await place(s.r, s.d.id, s.pid, 2).expect(201)).body.order;
    expect(o.total).toBe('140.00');

    await request(app).post(`/api/v1/pricing/lists/${l.id}/items`).set(auth(s.d.token)).send({ product_id: s.pid, price: '95' }).expect(201);
    await request(app).patch(`/api/v1/catalog/${s.pid}`).set(auth(s.d.token)).send({ price: '120' }).expect(200);
    const again = (await request(app).get(`/api/v1/orders/${o.id}`).set(auth(s.r.token)).expect(200)).body;
    expect(again.total).toBe('140.00');
    expect(again.items[0]).toMatchObject({ unit_price: '70.00', price_list: 'Temp deal' });
    expect(await quote(s, s.r.id)).toMatchObject({ unit_price: '95.00' });                      // new orders use the new price

    // a list that priced an order is kept, not deleted
    expect((await request(app).delete(`/api/v1/pricing/lists/${l.id}`).set(auth(s.d.token))).body.error.code).toBe('IN_USE');
    await request(app).put(`/api/v1/pricing/lists/${l.id}`).set(auth(s.d.token)).send({ is_active: false }).expect(200);
    expect(await quote(s, s.r.id)).toMatchObject({ basis: 'standard' });
  });

  it('honours date windows', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Diwali', kind: 'promotion', valid_from: shift(5), valid_to: shift(10) });
    await s.item(l.id, { product_id: s.pid, percent_off: 20 });
    await s.members(l.id, [s.r.id]);
    expect(await quote(s, s.r.id, 1, today())).toMatchObject({ unit_price: '100.00' });         // not started
    expect(await quote(s, s.r.id, 1, shift(7))).toMatchObject({ unit_price: '80.00', applied: { kind: 'promotion' } });
    expect(await quote(s, s.r.id, 1, shift(11))).toMatchObject({ unit_price: '100.00' });       // ended
    expect((await request(app).post('/api/v1/pricing/lists').set(auth(s.d.token)).send({ name: 'Backwards', kind: 'group', valid_from: shift(5), valid_to: shift(1) })).status).toBe(400);
  });

  it('a regional list applies by pincode with no member list', async () => {
    const d = await reg('distributor');
    const near = await reg('retailer', '400055'); const far = await reg('retailer', '560001');
    await link(d, near); await link(d, far);
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Oil', price: '200', stock_qty: 50, gst_rate_bps: 0 })).body.id;
    const l = (await request(app).post('/api/v1/pricing/lists').set(auth(d.token)).send({ name: 'Mumbai', kind: 'regional', pincode_prefixes: ['400'] }).expect(201)).body;
    await request(app).post(`/api/v1/pricing/lists/${l.id}/items`).set(auth(d.token)).send({ product_id: pid, price: '180' }).expect(201);
    const get = async (r: { id: number }) => (await request(app).get('/api/v1/pricing/quote').query({ retailer_id: r.id, product_id: pid }).set(auth(d.token)).expect(200)).body;
    expect(await get(near)).toMatchObject({ unit_price: '180.00', applied: { kind: 'regional' } });
    expect(await get(far)).toMatchObject({ unit_price: '200.00', applied: null });
    expect((await request(app).post('/api/v1/pricing/lists').set(auth(d.token)).send({ name: 'Nowhere', kind: 'regional' })).status).toBe(400);
    expect((await request(app).put(`/api/v1/pricing/lists/${l.id}/members`).set(auth(d.token)).send({ retailer_ids: [near.id] })).body.error.code).toBe('REGIONAL_LIST');
  });

  it('explains which list won and which were passed over', async () => {
    const s = await setup();
    const group = await s.list({ name: 'Group', kind: 'group', priority: 1 });
    const contract = await s.list({ name: 'Contract', kind: 'contract' });
    for (const l of [group, contract]) await s.members(l.id, [s.r.id]);
    await s.item(group.id, { product_id: s.pid, price: '60' });
    await s.item(contract.id, { product_id: s.pid, price: '85' });
    const qt = await quote(s, s.r.id);
    expect(qt.unit_price).toBe('85.00');
    expect(qt.considered.map((c: any) => [c.name ?? c.list_name, c.kind, c.winner])).toEqual([['Contract', 'contract', true], ['Group', 'group', false]]);
  });

  it('refuses a price above standard unless the list allows it', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Premium', kind: 'contract' });
    await s.item(l.id, { product_id: s.pid, price: '130' });
    await s.members(l.id, [s.r.id]);
    expect(await quote(s, s.r.id)).toMatchObject({ unit_price: '100.00', basis: 'standard' });
    await request(app).put(`/api/v1/pricing/lists/${l.id}`).set(auth(s.d.token)).send({ allow_above_standard: true }).expect(200);
    expect(await quote(s, s.r.id)).toMatchObject({ unit_price: '130.00', basis: 'list' });
  });
});

describe('price list management', () => {
  it('only a distributor can manage lists, only for their own retailers and products', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Mine', kind: 'group' });
    expect((await request(app).get('/api/v1/pricing/lists').set(auth(s.r.token))).status).toBe(403);
    const rival = await reg('distributor'); const stranger = await reg('retailer');
    expect((await request(app).get(`/api/v1/pricing/lists/${l.id}`).set(auth(rival.token))).status).toBe(404);
    expect((await request(app).put(`/api/v1/pricing/lists/${l.id}/members`).set(auth(s.d.token)).send({ retailer_ids: [stranger.id] })).body.error.code).toBe('NOT_YOUR_RETAILER');
    const theirProduct = (await request(app).post('/api/v1/catalog').set(auth(rival.token)).send({ name: 'X', price: '5', stock_qty: 1 })).body.id;
    expect((await request(app).post(`/api/v1/pricing/lists/${l.id}/items`).set(auth(s.d.token)).send({ product_id: theirProduct, price: '4' })).status).toBe(404);
    // names are unique per distributor, ignoring case
    expect((await request(app).post('/api/v1/pricing/lists').set(auth(s.d.token)).send({ name: 'mine', kind: 'group' })).status).toBe(409);
  });

  it('keeps a history of changes and removes an unused list', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Scratch', kind: 'group' });
    await s.item(l.id, { product_id: s.pid, price: '90' });
    await s.item(l.id, { product_id: s.pid, price: '88' });
    await request(app).put(`/api/v1/pricing/lists/${l.id}`).set(auth(s.d.token)).send({ priority: 3 }).expect(200);
    const h = (await request(app).get(`/api/v1/pricing/lists/${l.id}/history`).set(auth(s.d.token)).expect(200)).body.entries;
    expect(h.map((e: any) => e.action)).toEqual(['pricing.list_update', 'pricing.item_set', 'pricing.item_set', 'pricing.list_create']);
    const detail = (await request(app).get(`/api/v1/pricing/lists/${l.id}`).set(auth(s.d.token)).expect(200)).body;
    expect(detail.item_list).toEqual([expect.objectContaining({ name: 'Rice', price: '88.00', min_qty: 1, standard_price: '100.00' })]);   // upsert, not a second row
    await request(app).delete(`/api/v1/pricing/lists/${l.id}`).set(auth(s.d.token)).expect(204);
    expect(await q1(pool, 'SELECT 1 FROM price_list_items WHERE price_list_id = ?', [l.id])).toBeUndefined();
  });

  it('validates values', async () => {
    const s = await setup();
    const l = await s.list({ name: 'Checks', kind: 'group' });
    const post = (b: object) => request(app).post(`/api/v1/pricing/lists/${l.id}/items`).set(auth(s.d.token)).send({ product_id: s.pid, ...b });
    expect((await post({ percent_off: 120 })).status).toBe(400);
    expect((await post({ price: '-5' })).status).toBe(400);
    expect((await post({ price: '12.345' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ price: '50', min_qty: 0 })).status).toBe(400);
  });
});
