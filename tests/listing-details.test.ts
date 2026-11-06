import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const dist = async () => {
  const p = String(7000000000 + 900000 + ++n);
  return (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `ld${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }).expect(201)).body.access_token as string;
};

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('product listing details', () => {
  it('stores highlights, specs, size, origin and tags, edits and clears them, and copies them on duplicate', async () => {
    const t = await dist();
    const made = (await request(app).post('/api/v1/catalog').set(auth(t)).send({
      name: 'Steel Bottle', price: '300', mrp: '400', stock_qty: 5, highlights: ['Keeps cold 24h', 'BPA free'], specs: [{ key: 'Material', value: 'Steel' }], tags: ['bottle', 'steel'],
      weight_g: 450, length_cm: 25.5, width_cm: 7, height_cm: 7, country_of_origin: 'India', manufacturer: 'Acme', shelf_life_days: 0, warranty_months: 12, return_days: 7,
    }).expect(201)).body;
    expect(made).toMatchObject({ highlights: ['Keeps cold 24h', 'BPA free'], specs: [{ key: 'Material', value: 'Steel' }], tags: ['bottle', 'steel'], weight_g: 450, length_cm: 25.5, country_of_origin: 'India', manufacturer: 'Acme', warranty_months: 12, return_days: 7 });

    const edited = (await request(app).patch(`/api/v1/catalog/${made.id}`).set(auth(t)).send({ highlights: [], weight_g: null, manufacturer: 'Beta' }).expect(200)).body;
    expect(edited.highlights).toEqual([]); expect(edited.weight_g).toBeNull(); expect(edited.manufacturer).toBe('Beta');
    expect(edited.specs).toEqual([{ key: 'Material', value: 'Steel' }]);   // untouched fields stay

    const copy = (await request(app).post(`/api/v1/catalog/${made.id}/duplicate`).set(auth(t)).send({}).expect(201)).body;
    expect(copy.specs).toEqual([{ key: 'Material', value: 'Steel' }]); expect(copy.manufacturer).toBe('Beta');

    await request(app).post('/api/v1/catalog').set(auth(t)).send({ name: 'Bad', price: '10', highlights: Array(9).fill('x') }).expect(400);
  });
});
