import bcrypt from 'bcryptjs';
import request from 'supertest';
import zlib from 'zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool } from '../src/db/pool';
import { parseRange, KPI_DEFINITIONS } from '../src/modules/reports/analytics';
import { runReportJob, sweepReportJobs } from '../src/modules/reports/jobs';
import { colName, crc32, safeText, toCsv, toXlsx } from '../src/utils/tabular';

const app = createApp();
let n = 0;
const phone = () => String(7400000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function admin() {
  const p = phone();
  const r = await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  const t = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
  return { id: r.insertId as number, token: t };
}
async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = (await request(app).post('/api/v1/auth/register').send(body).expect(201)).body;
  return { id: r.id as number, token: r.access_token as string, phone: p };
}
let k = 0;
const place = (r: { token: string }, did: number, pid: number, qty: number) =>
  request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'an' + ++k).send({ distributor_id: did, items: [{ product_id: pid, qty }] }).expect(201);
const move = (d: { token: string }, oid: number, to: string) => request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to }).expect(200);

/** One distributor, one retailer, a product at ₹100 + 18% GST. Orders: A delivered (4), B rejected (2), C still placed (1); 1 unit of A returned. */
async function scenario() {
  const d = await reg('distributor'); const r = await reg('retailer');
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '100', stock_qty: 100, gst_rate_bps: 1800 })).body.id as number;

  const a = (await place(r, d.id, pid, 4)).body.order.id as number;
  for (const to of ['accepted', 'dispatched', 'out_for_delivery', 'delivered']) await move(d, a, to);
  const b = (await place(r, d.id, pid, 2)).body.order.id as number;
  await move(d, b, 'rejected');
  await place(r, d.id, pid, 1);
  const ret = (await request(app).post('/api/v1/returns').set(auth(r.token)).set('Idempotency-Key', 'ar' + ++k).send({ order_id: a, reason: 'Damaged', items: [{ product_id: pid, qty: 1 }] }).expect(201)).body.return.id;
  await request(app).post(`/api/v1/returns/${ret}/resolve`).set(auth(d.token)).send({ action: 'approve' }).expect(200);
  return { d, r, pid };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('tabular output', () => {
  it('guards spreadsheet formulas but leaves real negative numbers alone', () => {
    expect(safeText('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`);
    expect(safeText('+91 98765')).toBe("'+91 98765");
    expect(safeText('@cmd')).toBe("'@cmd");
    expect(safeText('-12.50')).toBe('-12.50');
    expect(safeText('Sharma, "Sons" Traders')).toBe('Sharma, "Sons" Traders');
    expect(safeText(null)).toBe('');
  });

  it('writes CSV with quoting, a BOM and CRLF', () => {
    const csv = toCsv([{ key: 'a', header: 'Name' }, { key: 'b', header: 'Amount' }], [{ a: 'Sharma, "Sons"', b: '10.00' }, { a: '=1+1', b: '-5.00' }]).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual(['Name,Amount', '"Sharma, ""Sons""",10.00', "'=1+1,-5.00", '']);
  });

  it('names spreadsheet columns the way Excel does', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('writes a structurally valid XLSX: zip directory, checksums, numeric and text cells', () => {
    const x = toXlsx('Sales', [{ key: 'shop', header: 'Shop' }, { key: 'amt', header: 'Amount', type: 'number' }], [{ shop: 'A & B <Traders>', amt: '1250.50' }, { shop: '=cmd', amt: '' }]);
    expect(x.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = x.length - 22;
    expect(x.readUInt32LE(eocd)).toBe(0x06054b50);
    const count = x.readUInt16LE(eocd + 10);
    let p = x.readUInt32LE(eocd + 16);
    const names: string[] = []; const sheets: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      expect(x.readUInt32LE(p)).toBe(0x02014b50);
      const crc = x.readUInt32LE(p + 16); const size = x.readUInt32LE(p + 20);
      const nameLen = x.readUInt16LE(p + 28); const off = x.readUInt32LE(p + 42);
      const name = x.subarray(p + 46, p + 46 + nameLen).toString();
      const start = off + 30 + x.readUInt16LE(off + 26) + x.readUInt16LE(off + 28);
      const data = x.subarray(start, start + size);
      expect(crc32(data)).toBe(crc);
      expect(zlib.crc32?.(data) ?? crc).toBe(crc);
      names.push(name); sheets[name] = data.toString('utf8');
      p += 46 + nameLen;
    }
    expect(names.sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = sheets['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="B2"><v>1250.50</v></c>');                  // a number, so it can be summed
    expect(sheet).toContain('A &amp; B &lt;Traders&gt;');                    // escaped
    expect(sheet).toContain('&apos;=cmd');                                    // formula guard applies in XLSX too (apostrophe, XML-escaped)
    expect(sheets['xl/workbook.xml']).toContain('name="Sales"');
  });
});

describe('date ranges', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  it('defaults to the last 30 days including today', () => {
    expect(parseRange({}, now)).toMatchObject({ fromDate: '2026-09-14', toDate: '2026-10-13', days: 30 });
  });
  it('covers whole days and rejects nonsense', () => {
    expect(parseRange({ from: '2026-10-01', to: '2026-10-01' }, now)).toMatchObject({ from: '2026-10-01 00:00:00', to: '2026-10-01 23:59:59', days: 1 });
    expect(() => parseRange({ from: '2026-10-05', to: '2026-10-01' }, now)).toThrow(/must not be after/);
    expect(() => parseRange({ from: '2024-01-01', to: '2026-10-01' }, now)).toThrow(/at most 366/);
  });
  it('every KPI has a definition and a unit', () => {
    for (const d of KPI_DEFINITIONS) { expect(d.definition.length).toBeGreaterThan(20); expect(['money', 'count', 'percent', 'hours']).toContain(d.unit); }
  });
});

describe('analytics against real orders', () => {
  it('computes each KPI exactly as defined', async () => {
    const a = await admin(); const { d } = await scenario();
    const body = (await request(app).get('/api/v1/admin/analytics').query({ distributor_id: d.id }).set(auth(a.token)).expect(200)).body;
    const k2 = body.kpis;
    // A: 4 x 100 + 18% = 472 delivered.  B: 236 rejected (never counts).  C: 118 placed.  Return: 1 unit = 118 incl, 100 excl.
    expect(k2).toMatchObject({
      gmv: '590.00', gross_sales: '472.00', tax_collected: '72.00', returns: '118.00', net_sales: '300.00',
      platform_revenue: '0.00', gross_profit: null,
      total_orders: 3, pending_orders: 1, delivered_orders: 1, cancelled_orders: 1,
      active_buyers: 1, active_distributors: 1, total_products: 1, low_stock_products: 0,
      outstanding_credit: '354.00', pending_refunds: '0.00', repeat_purchase_rate: 100,
    });
    expect(k2.avg_fulfilment_hours).toBeGreaterThanOrEqual(0);

    const today = new Date().toISOString().slice(0, 10);
    expect(body.series.revenue_trend.at(-1)).toEqual({ date: today, orders: 3, gmv: '590.00' });
    expect(body.series.revenue_trend).toHaveLength(30);
    expect(body.series.category_performance).toEqual([{ category: 'Uncategorised', revenue: '590.00', units: 5 }]);
    expect(body.series.top_products[0]).toMatchObject({ name: 'Rice', units: 5, revenue: '590.00' });
    expect(body.series.distributor_performance[0]).toMatchObject({ distributor_id: d.id, orders: 3, delivered: 1, gmv: '590.00' });
    expect(body.series.regional_sales).toEqual([{ region: '400', orders: 2, gmv: '590.00' }]);
    expect(body.series.collection_trend.at(-1)).toMatchObject({ invoiced: '472.00', collected: '0.00' });
  });

  it('a period without activity is all zeros, and another distributor sees none of it', async () => {
    const a = await admin(); const { d } = await scenario();
    const past = (await request(app).get('/api/v1/admin/analytics').query({ from: '2020-01-01', to: '2020-01-31', distributor_id: d.id }).set(auth(a.token)).expect(200)).body;
    expect(past.kpis).toMatchObject({ gmv: '0.00', net_sales: '0.00', total_orders: 0, repeat_purchase_rate: null, avg_fulfilment_hours: null });
    const other = await reg('distributor');
    const none = (await request(app).get('/api/v1/admin/analytics').query({ distributor_id: other.id }).set(auth(a.token)).expect(200)).body;
    expect(none.kpis).toMatchObject({ gmv: '0.00', total_orders: 0 });
  });

  it('counts delivered commission as platform revenue', async () => {
    const a = await admin();
    const d = await reg('distributor'); const r = await reg('retailer');
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Oil', price: '1000', stock_qty: 10, gst_rate_bps: 0 })).body.id as number;
    // the retailer belongs to another distributor; this one is found by pincode, so its order is outside the hierarchy
    const home = await reg('distributor');
    await request(app).post('/api/v1/distributor/retailers').set(auth(home.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${home.id}/accept`).set(auth(r.token)).expect(200);
    await request(app).put('/api/v1/distributor/pincodes').set(auth(d.token)).send({ pincodes: ['400001'] }).expect(200);
    const o = await place(r, d.id, pid, 1);
    expect(o.body.order.is_out_of_hierarchy).toBe(true);
    for (const to of ['accepted', 'dispatched', 'out_for_delivery', 'delivered']) await move(d, o.body.order.id, to);
    const rate = o.body.order.commission_rate_bps as number;
    const k2 = (await request(app).get('/api/v1/admin/analytics').query({ distributor_id: d.id }).set(auth(a.token)).expect(200)).body.kpis;
    expect(k2.platform_revenue_parts.commission).toBe(((1000 * rate) / 100 / 100).toFixed(2));
    expect(k2.platform_revenue).toBe(k2.platform_revenue_parts.commission);
  });

  it('is for the admin only', async () => {
    const d = await reg('distributor');
    expect((await request(app).get('/api/v1/admin/analytics').set(auth(d.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/reports').set(auth(d.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/analytics')).status).toBe(401);
  });

  it('refuses a bad range', async () => {
    const a = await admin();
    expect((await request(app).get('/api/v1/admin/analytics').query({ from: '2026-10-31', to: '2026-10-01' }).set(auth(a.token))).status).toBe(400);
    expect((await request(app).get('/api/v1/admin/analytics').query({ from: 'yesterday' }).set(auth(a.token))).status).toBe(400);
  });
});

describe('report exports', () => {
  const waitDone = async (token: string, id: number) => {
    for (let i = 0; i < 100; i++) {
      const j = (await request(app).get(`/api/v1/admin/reports/${id}`).set(auth(token)).expect(200)).body;
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('report never finished');
  };

  it('lists the catalogue', async () => {
    const a = await admin();
    const c = (await request(app).get('/api/v1/admin/reports/catalogue').set(auth(a.token)).expect(200)).body.reports;
    expect(c.map((x: any) => x.type)).toEqual(expect.arrayContaining(['orders', 'products', 'inventory_movements', 'distributors', 'buyers', 'payments', 'receivables', 'commissions']));
  });

  it('builds a CSV in the background and serves it only to the requester', async () => {
    const a = await admin(); const other = await admin();
    const { d } = await scenario();
    const made = await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'orders', format: 'csv', distributor_id: d.id }).expect(202);
    expect(['queued', 'running', 'done']).toContain(made.body.status);
    const job = await waitDone(a.token, made.body.id);
    expect(job).toMatchObject({ status: 'done', format: 'csv', row_count: 3, truncated: false });
    expect(job.file_name).toMatch(/^aayme-orders-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);

    const dl = await request(app).get(`/api/v1/admin/reports/${made.body.id}/download`).set(auth(a.token)).expect(200);
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['cache-control']).toContain('no-store');
    const lines = dl.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Order,Placed (UTC),Delivered (UTC),Distributor,Retailer,Pincode,Status,Total incl. GST (INR),GST (INR),Outside hierarchy,Invoice no.');
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.includes(',delivered,472.00,72.00,')).length).toBe(1);
    expect(lines.filter((l) => l.includes(',rejected,236.00,36.00,')).length).toBe(1);

    // someone else's report is invisible, even to another admin
    expect((await request(app).get(`/api/v1/admin/reports/${made.body.id}/download`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/admin/reports/${made.body.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).get('/api/v1/admin/reports').set(auth(other.token))).body.jobs).toEqual([]);
  });

  it('builds an XLSX', async () => {
    const a = await admin(); const { d } = await scenario();
    const made = (await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'products', format: 'xlsx', distributor_id: d.id }).expect(202)).body;
    const job = await waitDone(a.token, made.id);
    expect(job).toMatchObject({ status: 'done', row_count: 1 });
    const dl = await request(app).get(`/api/v1/admin/reports/${made.id}/download`).set(auth(a.token)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(dl.headers['content-type']).toContain('spreadsheetml');
    expect((dl.body as Buffer).readUInt32LE(0)).toBe(0x04034b50);
  });

  it('a job runs once even if two workers race for it', async () => {
    const a = await admin();
    const made = (await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'distributors' }).expect(202)).body;
    const results = await Promise.all([runReportJob(made.id), runReportJob(made.id), runReportJob(made.id)]);
    expect(results.filter((r) => r === 'done').length).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r === 'skipped').length).toBeGreaterThanOrEqual(2);
    const done = await waitDone(a.token, made.id);
    expect(done.status).toBe('done');
  });

  it('refuses unknown types, bad ranges, and more than three at once', async () => {
    const a = await admin();
    expect((await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'secrets' })).body.error.code).toBe('UNKNOWN_REPORT');
    expect((await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'orders', from: '2026-10-31', to: '2026-10-01' })).status).toBe(400);
    expect((await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'orders', format: 'pdf' })).status).toBe(400);
    // fill the queue directly so the limit is tested without racing the worker
    for (let i = 0; i < 3; i++) await exec(pool, "INSERT INTO report_jobs (requested_by, type, format, params, status) VALUES (?, 'orders', 'csv', '{}', 'queued')", [a.id]);
    expect((await request(app).post('/api/v1/admin/reports').set(auth(a.token)).send({ type: 'orders' })).body.error.code).toBe('TOO_MANY_REPORTS');
    await sweepReportJobs();
  });

  it('a stuck "running" job is failed by the sweeper, not left forever', async () => {
    const a = await admin();
    const r = await exec(pool, "INSERT INTO report_jobs (requested_by, type, format, params, status, started_at) VALUES (?, 'orders', 'csv', '{}', 'running', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))", [a.id]);
    await sweepReportJobs();
    const j = (await request(app).get(`/api/v1/admin/reports/${r.insertId}`).set(auth(a.token)).expect(200)).body;
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(/Interrupted/);
  });
});
