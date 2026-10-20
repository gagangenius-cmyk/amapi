import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('bulk import with barcodes', () => {
  it('imports rows with a barcode column, and scanning that barcode finds the product', async () => {
    const p = String(8700000000 + Math.floor(Math.random() * 99999));
    const reg = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Import Biz ' + p }).expect(201);
    const t = reg.body.access_token as string;
    const code = 'BC' + p;
    const res = await request(app).post('/api/v1/catalog/import/rows').set(auth(t)).send({ rows: [
      { name: 'Scan Rice', price: '100', barcode: code, stock: '5' },
      { name: 'Bad Code', price: '50', barcode: '!!' },
    ] }).expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    const found = (await request(app).get(`/api/v1/catalog/lookup?barcode=${code}`).set(auth(t)).expect(200)).body;
    expect(found).toMatchObject({ name: 'Scan Rice', barcode: code, stock_qty: 5 });
    // the same barcode again is reported, not crashed
    const again = (await request(app).post('/api/v1/catalog/import/rows').set(auth(t)).send({ rows: [{ name: 'Dup', price: '10', barcode: code }] }).expect(200)).body;
    expect(again.created).toBe(0);
    expect(again.errors[0].message).toMatch(/barcode/i);
  });
});
