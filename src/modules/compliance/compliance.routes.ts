import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1 } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { gspConfigured, submitEInvoice } from '../../services/gsp';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { assertSubscriptionActive } from '../distributors/subscription';
import { buildEInvoice, buildEWayBill, EWAY_THRESHOLD_PAISE, InvoiceInput } from './einvoice';

/** GST e-invoice (IRN) and e-way bill helpers for distributors. */
export const complianceRouter = Router();
complianceRouter.use(authenticate, requireRole('distributor'));

const INVOICEABLE = ['accepted', 'dispatched', 'out_for_delivery', 'delivered'];

async function load(orderId: number, distributorId: number) {
  const o = await q1<any>(pool, `
    SELECT o.*, dp.business_name, dp.gst_no, dp.address d_address, dp.city d_city, dp.pincode d_pincode, du.phone d_phone, du.email d_email,
      rp.shop_name, rp.address r_address, rp.pincode r_pincode, rp.gst_no r_gst, ru.phone r_phone, ru.email r_email
    FROM orders o JOIN distributor_profiles dp ON dp.user_id = o.distributor_id JOIN users du ON du.id = o.distributor_id
    JOIN retailer_profiles rp ON rp.user_id = o.retailer_id JOIN users ru ON ru.id = o.retailer_id
    WHERE o.id = ? AND o.distributor_id = ?`, [orderId, distributorId]);
  if (!o) throw notFound('Order');
  if (!INVOICEABLE.includes(o.status)) throw new AppError(409, 'NO_INVOICE', 'The order must be accepted before it has an invoice');
  const items = await q<any>(pool, 'SELECT oi.*, p.hsn, p.unit FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.qty > 0 ORDER BY oi.id', [orderId]);
  const accepted = await q1<any>(pool, "SELECT created_at FROM order_events WHERE order_id = ? AND to_status = 'accepted' ORDER BY id LIMIT 1", [orderId]);
  const input: InvoiceInput = {
    invoice_no: o.invoice_no, date: new Date(accepted?.created_at ?? o.created_at), total_paise: Number(o.total_paise),
    seller: { gstin: o.gst_no, name: o.business_name, address: o.d_address, city: o.d_city, pincode: o.d_pincode, phone: o.d_phone, email: o.d_email },
    buyer: { gstin: o.r_gst, name: o.shop_name, address: o.r_address, city: null, pincode: o.r_pincode, phone: o.r_phone, email: o.r_email },
    lines: items.map((i) => ({ name: i.name, hsn: i.hsn, unit: i.unit ?? 'pcs', qty: i.qty, unit_price_paise: Number(i.unit_price_paise), gst_rate_bps: i.gst_rate_bps, line_total_paise: Number(i.line_total_paise) })),
  };
  return { o, input };
}

const status = (o: any) => ({
  irn: o.irn ?? null, ack_no: o.irn_ack_no ?? null, ack_date: o.irn_ack_at ?? null, signed_qr: o.signed_qr ?? null,
  eway_bill_no: o.eway_bill_no ?? null, eway_valid_until: o.eway_valid_until ?? null,
});

// The e-invoice JSON for this order, and what is still missing before it can be uploaded.
complianceRouter.get('/orders/:id/einvoice', asyncHandler(async (req, res) => {
  const { o, input } = await load(idParam(req), req.auth!.userId);
  const built = buildEInvoice(input);
  res.json({ ready: built.errors.length === 0, errors: built.errors, warnings: built.warnings, payload: built.payload, ...status(o), can_submit: gspConfigured() && built.errors.length === 0 && !o.irn });
}));

const IRN = /^[a-f0-9]{64}$/i;

// Record an IRN that the portal (or your accountant) issued. Once set it can not be changed: it is a legal identifier.
complianceRouter.post('/orders/:id/einvoice/irn', asyncHandler(async (req, res) => {
  const b = z.object({ irn: z.string().trim().regex(IRN, 'IRN is 64 hexadecimal characters'), ack_no: z.string().trim().min(1).max(30), ack_date: z.string().datetime({ offset: true }).or(z.string().date()), signed_qr: z.string().max(5000).nullable().optional() }).parse(req.body);
  const { o } = await load(idParam(req), req.auth!.userId);
  await assertSubscriptionActive(pool, req.auth!.userId);
  if (o.irn) throw new AppError(409, 'IRN_EXISTS', 'This invoice already has an IRN');
  try {
    await exec(pool, 'UPDATE orders SET irn = ?, irn_ack_no = ?, irn_ack_at = ?, signed_qr = ? WHERE id = ? AND irn IS NULL', [b.irn.toLowerCase(), b.ack_no, new Date(b.ack_date), b.signed_qr ?? null, o.id]);
  } catch (e: any) { if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'IRN_USED', 'That IRN belongs to another invoice'); throw e; }
  await audit(req.auth!.userId, 'einvoice.irn_recorded', 'order', o.id, { irn: b.irn.toLowerCase(), ack_no: b.ack_no });
  res.json(status(await q1<any>(pool, 'SELECT * FROM orders WHERE id = ?', [o.id])));
}));

// Send it to the configured GSP and store the IRN it returns.
complianceRouter.post('/orders/:id/einvoice/generate', asyncHandler(async (req, res) => {
  if (!gspConfigured()) throw new AppError(501, 'GSP_NOT_CONFIGURED', 'No e-invoice provider is connected. Download the JSON and upload it on the e-invoice portal, then record the IRN here.');
  const { o, input } = await load(idParam(req), req.auth!.userId);
  await assertSubscriptionActive(pool, req.auth!.userId);
  if (o.irn) throw new AppError(409, 'IRN_EXISTS', 'This invoice already has an IRN');
  const built = buildEInvoice(input);
  if (built.errors.length) throw new AppError(422, 'EINVOICE_INVALID', 'The invoice is missing details the portal requires', { errors: built.errors });
  let r;
  try { r = await submitEInvoice(built.payload); } catch (err: any) { throw new AppError(502, 'GSP_ERROR', String(err?.message ?? err).slice(0, 200)); }
  await exec(pool, 'UPDATE orders SET irn = ?, irn_ack_no = ?, irn_ack_at = ?, signed_qr = ? WHERE id = ? AND irn IS NULL', [r.irn, r.ackNo, r.ackDate, r.signedQr, o.id]);
  await audit(req.auth!.userId, 'einvoice.generated', 'order', o.id, { irn: r.irn });
  res.status(201).json(status(await q1<any>(pool, 'SELECT * FROM orders WHERE id = ?', [o.id])));
}));

const eway = z.object({
  vehicle_no: z.string().trim().toUpperCase().regex(/^[A-Z0-9]*$/).optional(), distance: z.coerce.number().int().min(0).max(5000).optional(),
  transporter_id: z.string().trim().toUpperCase().optional(), transporter_name: z.string().trim().max(120).optional(),
});

complianceRouter.get('/orders/:id/eway', asyncHandler(async (req, res) => {
  const t = eway.parse(req.query);
  const { o, input } = await load(idParam(req), req.auth!.userId);
  const built = buildEWayBill(input, { vehicle_no: t.vehicle_no || undefined, distance_km: t.distance, transporter_id: t.transporter_id || undefined, transporter_name: t.transporter_name });
  res.json({ required: built.required, threshold: fromPaise(EWAY_THRESHOLD_PAISE), ready: built.errors.length === 0, errors: built.errors, warnings: built.warnings, payload: built.payload, ...status(o) });
}));

complianceRouter.post('/orders/:id/eway/record', asyncHandler(async (req, res) => {
  const b = z.object({ eway_bill_no: z.string().trim().regex(/^\d{12}$/, 'An e-way bill number is 12 digits'), valid_until: z.string().datetime({ offset: true }).or(z.string().date()) }).parse(req.body);
  const { o } = await load(idParam(req), req.auth!.userId);
  await exec(pool, 'UPDATE orders SET eway_bill_no = ?, eway_valid_until = ? WHERE id = ?', [b.eway_bill_no, new Date(b.valid_until), o.id]);
  await audit(req.auth!.userId, 'eway.recorded', 'order', o.id, { eway_bill_no: b.eway_bill_no });
  res.json(status(await q1<any>(pool, 'SELECT * FROM orders WHERE id = ?', [o.id])));
}));
