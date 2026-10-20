import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { exec, pool } from '../src/db/pool';
import { metresBetween, performanceOf } from '../src/modules/field/field.routes';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const phone = () => String(8800000000 + ++n * 7 + Math.floor(Math.random() * 5));

async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Dist ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret ' + p, password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = await request(app).post('/api/v1/auth/register').send(body).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
async function link(d: { token: string; id: number }, r: { token: string; phone: string }) {
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
}
async function employee(d: { token: string }) {
  const p = phone();
  const e = (await request(app).post('/api/v1/distributor/employees').set(auth(d.token)).send({ phone: p, name: 'Field Emp', password: 'password123' }).expect(201)).body;
  const token = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
  return { id: e.id as number, token, phone: p };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('pure helpers', () => {
  it('colours a shop by how recently it ordered', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
    expect(performanceOf(null, now).colour).toBe('grey');
    expect(performanceOf(ago(3), now).colour).toBe('green');
    expect(performanceOf(ago(15), now).colour).toBe('green');
    expect(performanceOf(ago(30), now).colour).toBe('amber');
    expect(performanceOf(ago(60), now).colour).toBe('red');
  });
  it('measures distance in metres', () => {
    expect(metresBetween(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
    const d = metresBetween(19.076, 72.8777, 19.077, 72.8777);
    expect(d).toBeGreaterThan(100); expect(d).toBeLessThan(120);
  });
});

describe('field sales', () => {
  it('shop location can be set once; the distributor can reset it', async () => {
    const d = await reg('distributor'); const r = await reg('retailer'); await link(d, r);
    expect((await request(app).get('/api/v1/field/shop-location').set(auth(r.token)).expect(200)).body.locked).toBe(false);
    await request(app).put('/api/v1/field/shop-location').set(auth(r.token)).send({ lat: 19.076, lng: 72.8777 }).expect(200);
    const second = await request(app).put('/api/v1/field/shop-location').set(auth(r.token)).send({ lat: 20, lng: 73 }).expect(409);
    expect(second.body.error.code).toBe('LOCATION_LOCKED');
    await request(app).put('/api/v1/field/shop-location').set(auth(r.token)).send({ lat: 999, lng: 0 }).expect(400);
    await request(app).post(`/api/v1/field/retailers/${r.id}/location/reset`).set(auth(d.token)).expect(200);
    await request(app).put('/api/v1/field/shop-location').set(auth(r.token)).send({ lat: 19.1, lng: 72.9 }).expect(200);
    // only the retailer's own distributor may reset
    const other = await reg('distributor');
    await request(app).post(`/api/v1/field/retailers/${r.id}/location/reset`).set(auth(other.token)).expect(404);
  });

  it('a distributor plans, changes and deletes beats for their own team and shops only', async () => {
    const d = await reg('distributor'); const e = await employee(d); const r1 = await reg('retailer'); const r2 = await reg('retailer');
    await link(d, r1); await link(d, r2);
    const stranger = await reg('retailer'); // not connected
    const beat = (await request(app).post('/api/v1/field/beats').set(auth(d.token)).send({ name: 'Monday market', employee_id: e.id, weekday: 1, retailer_ids: [r1.id, r2.id] }).expect(201)).body;
    expect(beat).toMatchObject({ name: 'Monday market', weekday: 1, employee_name: 'Field Emp' });
    expect(beat.retailers.map((x: any) => x.id)).toEqual([r1.id, r2.id]);

    await request(app).post('/api/v1/field/beats').set(auth(d.token)).send({ name: 'Bad', employee_id: e.id, weekday: 2, retailer_ids: [stranger.id] }).expect(400);
    const outsider = await employee(await reg('distributor'));
    await request(app).post('/api/v1/field/beats').set(auth(d.token)).send({ name: 'Bad', employee_id: outsider.id, weekday: 2, retailer_ids: [] }).expect(400);

    const changed = (await request(app).put(`/api/v1/field/beats/${beat.id}`).set(auth(d.token)).send({ weekday: 4, retailer_ids: [r2.id] }).expect(200)).body;
    expect(changed.weekday).toBe(4);
    expect(changed.retailers.map((x: any) => x.id)).toEqual([r2.id]);

    // an employee cannot manage beats; another distributor cannot touch this one
    await request(app).post('/api/v1/field/beats').set(auth(e.token)).send({ name: 'x', employee_id: e.id, weekday: 1 }).expect(403);
    await request(app).put(`/api/v1/field/beats/${beat.id}`).set(auth((await reg('distributor')).token)).send({ name: 'Mine now' }).expect(404);

    const opts = (await request(app).get('/api/v1/field/beats/options').set(auth(d.token)).expect(200)).body;
    expect(opts.employees).toHaveLength(1);
    expect(opts.shops).toHaveLength(2);

    await request(app).delete(`/api/v1/field/beats/${beat.id}`).set(auth(d.token)).expect(204);
    expect((await request(app).get('/api/v1/field/beats').set(auth(d.token)).expect(200)).body.beats).toHaveLength(0);
  });

  it('the employee scans the retailer QR to punch a visit; stale, foreign and repeated scans are handled', async () => {
    const d = await reg('distributor'); const e = await employee(d); const r = await reg('retailer'); await link(d, r);
    await request(app).put('/api/v1/field/shop-location').set(auth(r.token)).send({ lat: 19.076, lng: 72.8777 }).expect(200);
    const weekday = new Date(Date.now() + 5.5 * 3600_000).getUTCDay();
    await request(app).post('/api/v1/field/beats').set(auth(d.token)).send({ name: 'Today', employee_id: e.id, weekday, retailer_ids: [r.id] }).expect(201);

    const today = (await request(app).get('/api/v1/field/today').set(auth(e.token)).expect(200)).body;
    expect(today.beats[0].retailers[0]).toMatchObject({ id: r.id, visited_at: null });

    const code = (await request(app).get('/api/v1/field/visit-code').set(auth(r.token)).expect(200)).body.code as string;
    expect(code.startsWith('aayme-visit:')).toBe(true);
    // a QR is only for the retailer to show: employees and distributors have none
    await request(app).get('/api/v1/field/visit-code').set(auth(e.token)).expect(403);

    const punch = await request(app).post('/api/v1/field/punch').set(auth(e.token)).send({ code, lat: 19.0761, lng: 72.8778 }).expect(201);
    expect(punch.body).toMatchObject({ near: true, planned: true, repeated: false });
    const again = await request(app).post('/api/v1/field/punch').set(auth(e.token)).send({ code, lat: 19.0761, lng: 72.8778 }).expect(200);
    expect(again.body.repeated).toBe(true);

    const after = (await request(app).get('/api/v1/field/today').set(auth(e.token)).expect(200)).body;
    expect(after.beats[0].retailers[0].visited_at).not.toBeNull();

    const far = (await request(app).post('/api/v1/field/punch').set(auth((await employee(d)).token)).send({ code, lat: 28.6, lng: 77.2 }).expect(201)).body;
    expect(far.near).toBe(false);

    const expired = jwt.sign({ purpose: 'visit', r: r.id }, env.jwtSecret, { expiresIn: -10 });
    await request(app).post('/api/v1/field/punch').set(auth(e.token)).send({ code: `aayme-visit:${expired}` }).expect(400);
    await request(app).post('/api/v1/field/punch').set(auth(e.token)).send({ code: 'aayme-visit:not-a-real-token-at-all-xx' }).expect(400);
    const other = await employee(await reg('distributor'));
    await request(app).post('/api/v1/field/punch').set(auth(other.token)).send({ code }).expect(403);

    const visits = (await request(app).get('/api/v1/field/visits').set(auth(d.token)).expect(200)).body.visits;
    expect(visits.length).toBe(2);
  });

  it('the map lists shops nearest first with colour, phone and a directions link; employees see only their own shops', async () => {
    const d = await reg('distributor'); const e = await employee(d);
    const near = await reg('retailer'); const far = await reg('retailer'); const unlocated = await reg('retailer'); const notMine = await reg('retailer');
    for (const r of [near, far, unlocated, notMine]) await link(d, r);
    await request(app).put('/api/v1/field/shop-location').set(auth(near.token)).send({ lat: 19.0761, lng: 72.8777 }).expect(200);
    await request(app).put('/api/v1/field/shop-location').set(auth(far.token)).send({ lat: 19.2, lng: 72.9 }).expect(200);
    await request(app).put('/api/v1/field/shop-location').set(auth(notMine.token)).send({ lat: 19.5, lng: 73 }).expect(200);
    await request(app).post('/api/v1/field/beats').set(auth(d.token)).send({ name: 'All', employee_id: e.id, weekday: 3, retailer_ids: [far.id, near.id, unlocated.id] }).expect(201);

    const all = (await request(app).get('/api/v1/field/map?lat=19.076&lng=72.8777').set(auth(d.token)).expect(200)).body;
    expect(all.total).toBe(4);
    expect(all.shops.map((s: any) => s.id).slice(0, 2)).toEqual([near.id, far.id]); // ascending distance
    expect(all.shops[0]).toMatchObject({ located: true, performance: { colour: 'grey' } });
    expect(all.shops[0].directions_url).toContain('google.com/maps');
    expect(all.shops.at(-1).located).toBe(false);

    const mine = (await request(app).get('/api/v1/field/map?lat=19.076&lng=72.8777').set(auth(e.token)).expect(200)).body;
    expect(mine.shops.map((s: any) => s.id).sort()).toEqual([far.id, near.id, unlocated.id].sort());

    // a recent order turns the shop green
    await exec(pool, "INSERT INTO orders (retailer_id, distributor_id, status, total_paise, idempotency_key) VALUES (?,?,'delivered',10000,?)", [near.id, d.id, 'field-' + near.id]);
    const after = (await request(app).get('/api/v1/field/map?lat=19.076&lng=72.8777').set(auth(d.token)).expect(200)).body;
    expect(after.shops.find((s: any) => s.id === near.id).performance.colour).toBe('green');
  });
});
