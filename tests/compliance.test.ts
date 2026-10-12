import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { buildEInvoice, buildEWayBill, InvoiceInput, taxSplit, uqc } from '../src/modules/compliance/einvoice';

const app = createApp();
let n = 0;
const phone = () => String(7400000000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const party = (gstin: string | null, extra: object = {}) => ({ gstin, name: 'Acme Traders', address: '12 Market Road', city: 'Pune', pincode: '411001', ...extra });
const line = (extra: object = {}) => ({ name: 'Rice', hsn: '1006', unit: 'kg', qty: 2, unit_price_paise: 10000, gst_rate_bps: 500, line_total_paise: 21000, ...extra });
const inv = (extra: Partial<InvoiceInput> = {}): InvoiceInput => ({
  invoice_no: '2026-27/00001', date: new Date('2026-06-01T10:00:00Z'), seller: party('27ABCDE1234F1Z5'), buyer: party('27PQRST5678G1Z9', { name: 'Ravi Kirana' }), lines: [line()], total_paise: 21000, ...extra,
});

describe('e-invoice builder', () => {
  it('splits tax into CGST + SGST within a state and IGST across states, and totals add up', () => {
    const a = buildEInvoice(inv());
    expect(a.errors).toEqual([]);
    expect(a.intra_state).toBe(true);
    expect(a.payload.ItemList[0]).toMatchObject({ HsnCd: '1006', Unit: 'KGS', Qty: 2, UnitPrice: 100, AssAmt: 200, GstRt: 5, CgstAmt: 5, SgstAmt: 5, IgstAmt: 0, TotItemVal: 210 });
    expect(a.payload.ValDtls).toEqual({ AssVal: 200, CgstVal: 5, SgstVal: 5, IgstVal: 0, TotInvVal: 210 });
    expect(a.payload.DocDtls).toEqual({ Typ: 'INV', No: '2026-27/00001', Dt: '01/06/2026' });
    expect(a.payload.SellerDtls).toMatchObject({ Gstin: '27ABCDE1234F1Z5', Stcd: '27', Pin: 411001 });
    expect(a.payload.BuyerDtls).toMatchObject({ Pos: '27', Stcd: '27' });

    const b = buildEInvoice(inv({ buyer: party('29PQRST5678G1Z9') }));
    expect(b.intra_state).toBe(false);
    expect(b.payload.ItemList[0]).toMatchObject({ IgstAmt: 10, CgstAmt: 0, SgstAmt: 0 });
    expect(b.payload.ValDtls).toMatchObject({ IgstVal: 10, CgstVal: 0, TotInvVal: 210 });
    expect(b.payload.BuyerDtls.Pos).toBe('29');
  });

  it('never loses a paisa when tax is odd, and CGST + SGST always equal the tax', () => {
    expect(taxSplit(7, true)).toEqual({ cgst: 3, sgst: 4, igst: 0 });
    expect(taxSplit(7, false)).toEqual({ cgst: 0, sgst: 0, igst: 7 });
    const r = buildEInvoice(inv({ lines: [line({ qty: 1, unit_price_paise: 101, line_total_paise: 106 })], total_paise: 106 }));
    const it = r.payload.ItemList[0];
    expect(Number((it.CgstAmt + it.SgstAmt).toFixed(2))).toBe(0.05);
  });

  it('lists exactly what is missing instead of producing a half-valid file', () => {
    const r = buildEInvoice(inv({
      seller: party('BAD', { address: '', pincode: '12', city: '' }), buyer: party(null), invoice_no: 'has spaces!', lines: [line({ hsn: null }), line({ hsn: '10', gst_rate_bps: 700 })],
    }));
    const text = r.errors.join('\n');
    expect(text).toContain('Seller: a valid 15-character GSTIN');
    expect(text).toContain('Seller: address is required');
    expect(text).toContain('Seller: a 6-digit pincode');
    expect(text).toContain('Seller: city is required');
    expect(text).toContain('Buyer has no GSTIN');
    expect(text).toContain('Invoice number must be');
    expect(text).toContain('Item 1 (Rice): HSN');
    expect(text).toContain('Item 2 (Rice): HSN');
    expect(text).toContain('7% is not a valid slab');
    expect(buildEInvoice(inv({ total_paise: 99999 })).errors.join()).toContain('Items add up to');
    expect(buildEInvoice(inv({ buyer: party('27PQRST5678G1Z9', { city: null }) })).warnings.join()).toContain('city is not on file');
  });

  it('maps units to the government unit codes', () => {
    expect([uqc('pcs'), uqc('KG'), uqc('Litre'), uqc('box'), uqc('dozen'), uqc('ml')]).toEqual(['PCS', 'KGS', 'OTH', 'BOX', 'DOZ', 'MLT']);
  });
});

describe('e-way bill builder', () => {
  const big = inv({ lines: [line({ qty: 1000, unit_price_paise: 6000, line_total_paise: 6300000 })], total_paise: 6300000 });
  it('is required above ₹50,000 and carries the transport details', () => {
    const r = buildEWayBill(big, { vehicle_no: 'MH12AB1234', distance_km: 120 });
    expect(r.required).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.payload).toMatchObject({ supplyType: 'O', docType: 'INV', fromStateCode: 27, toStateCode: 27, totalValue: 60000, totInvValue: 63000, vehicleNo: 'MH12AB1234', transDistance: '120' });
    expect(r.payload.itemList[0]).toMatchObject({ hsnCode: 1006, cgstRate: 2.5, sgstRate: 2.5, igstRate: 0 });
    expect(buildEWayBill(inv(), { vehicle_no: 'MH12AB1234', distance_km: 5 }).required).toBe(false);
  });
  it('rejects bad transport details', () => {
    expect(buildEWayBill(big, {}).errors.join()).toContain('vehicle number or a transporter id');
    expect(buildEWayBill(big, { vehicle_no: 'xx', distance_km: 5 }).errors.join()).toContain('Vehicle number looks like');
    expect(buildEWayBill(big, { vehicle_no: 'MH12AB1234' }).errors.join()).toContain('Distance');
    expect(buildEWayBill(big, { transporter_id: 'nope', distance_km: 5 }).errors.join()).toContain('Transporter id');
  });
});

// ------------------------------------------------------------------------------------------------ API
async function reg(role: 'distributor' | 'retailer', extra: object = {}) {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@test.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@test.local`, name: 'Ret', password: 'password123', shop_name: 'Shop ' + p, pincode: '411002', address: '5 Lane' };
  const r = await request(app).post('/api/v1/auth/register').send({ ...body, ...extra }).expect(201);
  return { id: r.body.id as number, token: r.body.access_token as string, phone: p };
}
let k = 0;
async function acceptedOrder(opts: { complete?: boolean; qty?: number; price?: string } = {}) {
  const complete = opts.complete !== false;
  const d = await reg('distributor', { gst_no: '27ABCDE1234F1Z5' }); const r = await reg('retailer', complete ? { gst_no: '27PQRST5678G1Z9' } : {});
  if (complete) await request(app).put('/api/v1/distributor/me').set(auth(d.token)).send({ address: '1 Station Road', city: 'Pune', pincode: '411001' }).expect(200);
  await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
  await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
  const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: opts.price ?? '100', stock_qty: 5000, gst_rate_bps: 500, hsn: '1006', unit: 'kg' })).body.id;
  const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'c-' + ++k).send({ distributor_id: d.id, items: [{ product_id: pid, qty: opts.qty ?? 2 }] }).expect(201)).body.order.id;
  await request(app).post(`/api/v1/orders/${oid}/transition`).set(auth(d.token)).send({ to: 'accepted' }).expect(200);
  return { d, r, oid };
}

let gsp: http.Server; let gspMode: 'ok' | 'reject' = 'ok'; const gspCalls: any[] = [];
beforeAll(async () => {
  await migrate(true);
  gsp = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      gspCalls.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      res.setHeader('Content-Type', 'application/json');
      if (gspMode === 'reject') { res.statusCode = 400; return void res.end(JSON.stringify({ message: 'GSTIN not active' })); }
      res.end(JSON.stringify({ Irn: crypto.randomBytes(32).toString('hex'), AckNo: '112010000123456', AckDt: '2026-06-01 15:30:00', SignedQRCode: 'eyJhbGciOi...' }));
    });
  });
  await new Promise<void>((ok) => gsp.listen(0, '127.0.0.1', ok));
});
afterEach(() => { delete process.env.EINVOICE_GSP_URL; delete process.env.EINVOICE_GSP_TOKEN; gspMode = 'ok'; });
afterAll(async () => { gsp.close(); await pool.end(); });
const connectGsp = () => { process.env.EINVOICE_GSP_URL = `http://127.0.0.1:${(gsp.address() as any).port}/irn`; process.env.EINVOICE_GSP_TOKEN = 'gsp-secret'; };

describe('e-invoice API', () => {
  it('builds the JSON for an accepted order, and shows what is missing when the profile is incomplete', async () => {
    const full = await acceptedOrder();
    const ok = (await request(app).get(`/api/v1/compliance/orders/${full.oid}/einvoice`).set(auth(full.d.token)).expect(200)).body;
    expect(ok.ready).toBe(true);
    expect(ok.payload.ValDtls).toMatchObject({ AssVal: 200, CgstVal: 5, SgstVal: 5, TotInvVal: 210 });
    expect(ok.payload.DocDtls.No).toMatch(/^\d{4}-\d{2}\/\d{5}$/);
    expect(ok.can_submit).toBe(false);                                           // no GSP connected

    const partial = await acceptedOrder({ complete: false });
    const bad = (await request(app).get(`/api/v1/compliance/orders/${partial.oid}/einvoice`).set(auth(partial.d.token)).expect(200)).body;
    expect(bad.ready).toBe(false);
    expect(bad.errors.join()).toContain('Seller: address is required');
    expect(bad.errors.join()).toContain('Buyer has no GSTIN');
  });

  it('is private to the order\'s distributor', async () => {
    const a = await acceptedOrder(); const other = await reg('distributor'); const ret = a.r;
    await request(app).get(`/api/v1/compliance/orders/${a.oid}/einvoice`).set(auth(other.token)).expect(404);
    await request(app).get(`/api/v1/compliance/orders/${a.oid}/einvoice`).set(auth(ret.token)).expect(403);
    await request(app).get(`/api/v1/compliance/orders/${a.oid}/einvoice`).expect(401);
  });

  it('records an IRN once, rejects duplicates, and prints it on the invoice', async () => {
    const a = await acceptedOrder(); const b = await acceptedOrder();
    const irn = crypto.randomBytes(32).toString('hex');
    const rec = (body: object, who = a) => request(app).post(`/api/v1/compliance/orders/${who.oid}/einvoice/irn`).set(auth(who.d.token)).send(body);
    expect((await rec({ irn: 'short', ack_no: '1', ack_date: '2026-06-01' })).status).toBe(400);
    const ok = await rec({ irn, ack_no: '112010000999', ack_date: '2026-06-01T15:30:00+05:30', signed_qr: 'QR-DATA' });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ irn, ack_no: '112010000999', signed_qr: 'QR-DATA' });
    expect((await rec({ irn: crypto.randomBytes(32).toString('hex'), ack_no: '2', ack_date: '2026-06-01' })).body.error.code).toBe('IRN_EXISTS');      // immutable
    expect((await rec({ irn, ack_no: '3', ack_date: '2026-06-01' }, b)).body.error.code).toBe('IRN_USED');                                              // another invoice's IRN

    const link = (await request(app).get(`/api/v1/orders/${a.oid}/invoice-link`).set(auth(a.r.token)).expect(200)).body.url as string;
    const html = (await request(app).get(new URL(link, 'http://x').pathname + new URL(link, 'http://x').search).expect(200)).text;
    expect(html).toContain(irn);
    expect(html).toContain('112010000999');
  });

  it('sends the invoice to a connected GSP and stores the IRN it returns', async () => {
    const a = await acceptedOrder();
    const gen = () => request(app).post(`/api/v1/compliance/orders/${a.oid}/einvoice/generate`).set(auth(a.d.token));
    expect((await gen()).status).toBe(501);                                       // nothing connected yet
    connectGsp();
    const ok = await gen();
    expect(ok.status).toBe(201); expect(ok.body.irn).toMatch(/^[a-f0-9]{64}$/); expect(ok.body.ack_no).toBe('112010000123456');
    expect(gspCalls.at(-1).auth).toBe('Bearer gsp-secret');
    expect(gspCalls.at(-1).body.Version).toBe('1.1');
    expect((await gen()).status).toBe(409);                                       // can only be issued once

    const b = await acceptedOrder(); gspMode = 'reject';
    const rej = await request(app).post(`/api/v1/compliance/orders/${b.oid}/einvoice/generate`).set(auth(b.d.token));
    expect(rej.status).toBe(502); expect(rej.body.error.message).toContain('GSTIN not active');
    expect((await request(app).get(`/api/v1/compliance/orders/${b.oid}/einvoice`).set(auth(b.d.token))).body.irn).toBeNull();   // nothing stored on failure

    const c = await acceptedOrder({ complete: false });
    expect((await request(app).post(`/api/v1/compliance/orders/${c.oid}/einvoice/generate`).set(auth(c.d.token))).status).toBe(422);   // not valid, never sent
  });
});

describe('e-way bill API', () => {
  it('says whether one is needed and builds the payload', async () => {
    const small = await acceptedOrder();
    const s = (await request(app).get(`/api/v1/compliance/orders/${small.oid}/eway`).query({ vehicle_no: 'MH12AB1234', distance: 40 }).set(auth(small.d.token))).body;
    expect(s.required).toBe(false); expect(s.ready).toBe(true);

    const big = await acceptedOrder({ qty: 600, price: '100' });                  // ₹63,000
    const g = await request(app).get(`/api/v1/compliance/orders/${big.oid}/eway`).query({ vehicle_no: 'MH12AB1234', distance: 40 }).set(auth(big.d.token));
    expect(g.body.required).toBe(true); expect(g.body.payload.totInvValue).toBe(63000);
    expect((await request(app).get(`/api/v1/compliance/orders/${big.oid}/eway`).set(auth(big.d.token))).body.ready).toBe(false);   // no transport details yet

    await request(app).post(`/api/v1/compliance/orders/${big.oid}/eway/record`).set(auth(big.d.token)).send({ eway_bill_no: '12345', valid_until: '2026-06-03' }).expect(400);
    const rec = await request(app).post(`/api/v1/compliance/orders/${big.oid}/eway/record`).set(auth(big.d.token)).send({ eway_bill_no: '341009876543', valid_until: '2026-06-03' }).expect(200);
    expect(rec.body.eway_bill_no).toBe('341009876543');
  });
});
