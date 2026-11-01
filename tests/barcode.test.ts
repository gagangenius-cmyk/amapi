import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const phone = () => String(7000000000 + 800000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const dist = async () => {
  const p = phone();
  return (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }).expect(201)).body.access_token as string;
};
const info = (t: string, code: string) => request(app).get(`/api/v1/catalog/barcode-info?barcode=${code}`).set(auth(t));

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('barcode lookup', () => {
  it('finds your own product, suggests only product facts from another distributor, else nothing', async () => {
    const d1 = await dist(); const d2 = await dist();
    await request(app).post('/api/v1/catalog').set(auth(d1)).send({ name: 'Realme C55', brand: 'Realme', unit: 'pcs', price: '9000', mrp: '11000', gst_rate_bps: 1800, hsn: '8517', barcode: 'RM55-0001', stock_qty: 3 }).expect(201);

    const own = (await info(d1, 'RM55-0001').expect(200)).body;
    expect(own.source).toBe('own');
    expect(own.existing.name).toBe('Realme C55');

    const other = (await info(d2, 'RM55-0001').expect(200)).body;
    expect(other.source).toBe('catalog');
    expect(other.suggestion).toMatchObject({ name: 'Realme C55', brand: 'Realme', hsn: '8517', gst_rate_bps: 1800 });
    expect(Object.keys(other.suggestion)).not.toContain('price');
    expect(JSON.stringify(other)).not.toMatch(/stock|distributor_id|"price"/);

    expect((await info(d1, 'NOPE-12345').expect(200)).body.source).toBe('none');
  });

  it('only imports photos from the public product databases', async () => {
    const d = await dist();
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d)).send({ name: 'Plain', price: '10', stock_qty: 1 }).expect(201)).body.id;
    const imp = (url: string) => request(app).post(`/api/v1/catalog/${pid}/images/import`).set(auth(d)).send({ url });
    expect((await imp('https://evil.example.com/a.jpg')).status).toBe(400);
    expect((await imp('http://images.openfoodfacts.org/a.jpg')).status).toBe(400);
    expect((await imp('https://169.254.169.254/latest/meta-data')).status).toBe(400);
    expect((await imp('https://openfoodfacts.org.evil.com/a.jpg')).status).toBe(400);
  });
});
