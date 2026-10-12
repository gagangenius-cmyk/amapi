import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { pool, q, q1 } from '../../db/pool';
import { authenticate } from '../../middleware/auth';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';

export const invoiceRouter = Router();

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const INVOICEABLE = ['accepted', 'dispatched', 'out_for_delivery', 'delivered'];

// A short-lived signed link, so the invoice can open in a browser/share sheet without the app's auth header.
invoiceRouter.get('/orders/:id/invoice-link', authenticate, asyncHandler(async (req, res) => {
  const a = req.auth!;
  const id = idParam(req);
  const o = await q1<any>(pool, 'SELECT retailer_id, distributor_id, status FROM orders WHERE id = ?', [id]);
  const inScope = o && ((a.role === 'retailer' && o.retailer_id === a.userId) || ((a.role === 'distributor' || a.role === 'employee') && o.distributor_id === a.distributorId));
  if (!inScope) throw notFound('Order');
  if (!INVOICEABLE.includes(o.status)) throw new AppError(409, 'NOT_INVOICEABLE', 'Invoice is available once the order is accepted');
  const t = jwt.sign({ orderId: id, purpose: 'invoice' }, env.jwtSecret, { expiresIn: '10m' });
  res.json({ url: `${req.protocol}://${req.get('host')}/api/v1/orders/${id}/invoice?t=${t}`, expires_in: 600 });
}));

invoiceRouter.get('/orders/:id/invoice', asyncHandler(async (req, res) => {
  const id = idParam(req);
  try {
    const p = jwt.verify(String(req.query.t ?? ''), env.jwtSecret) as any;
    if (p.purpose !== 'invoice' || p.orderId !== id) throw new Error('scope');
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invoice link is invalid or expired');
  }

  const o = await q1<any>(pool, `
    SELECT o.*, dp.business_name, dp.gst_no, rp.shop_name, rp.address, rp.pincode, rp.gst_no AS retailer_gst_no, ru.phone retailer_phone
    FROM orders o JOIN distributor_profiles dp ON dp.user_id = o.distributor_id
    JOIN retailer_profiles rp ON rp.user_id = o.retailer_id JOIN users ru ON ru.id = o.retailer_id WHERE o.id = ?`, [id]);
  if (!o || !INVOICEABLE.includes(o.status)) throw notFound('Invoice');
  const items = await q<any>(pool, 'SELECT oi.*, p.hsn FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.qty > 0', [id]);
  const accepted = await q1<any>(pool, "SELECT created_at FROM order_events WHERE order_id = ? AND to_status = 'accepted' ORDER BY id LIMIT 1", [id]);

  let taxable = 0;
  let gst = 0;
  const rows = items.map((i) => {
    const base = Number(i.unit_price_paise) * i.qty;
    const tax = Number(i.line_total_paise) - base;
    taxable += base;
    gst += tax;
    return `<tr><td>${esc(i.name)}</td><td>${esc(i.hsn)}</td><td class="r">${i.qty}</td><td class="r">${fromPaise(Number(i.unit_price_paise))}</td>
      <td class="r">${fromPaise(base)}</td><td class="r">${i.gst_rate_bps / 100}%</td><td class="r">${fromPaise(tax)}</td><td class="r">${fromPaise(Number(i.line_total_paise))}</td></tr>`;
  }).join('');
  // The first two digits of a GSTIN are the state code: same state -> CGST + SGST, different -> IGST.
  const stateOf = (g?: string | null) => (g && /^\d{2}[A-Z0-9]{13}$/i.test(g.trim()) ? g.trim().slice(0, 2) : null);
  const supplierState = stateOf(o.gst_no);
  const buyerState = stateOf(o.retailer_gst_no);
  const cgst = Math.floor(gst / 2);
  const taxNote = supplierState && buyerState
    ? supplierState === buyerState
      ? `Intra-state supply (state ${supplierState}): CGST ${fromPaise(cgst)} + SGST ${fromPaise(gst - cgst)}.`
      : `Inter-state supply (${supplierState} to ${buyerState}): IGST ${fromPaise(gst)}.`
    : `GST ${fromPaise(gst)} in total. The CGST+SGST / IGST split depends on place of supply; add the buyer's GSTIN to show it.`;
  const invoiceNo = o.invoice_no ?? `INV-${String(id).padStart(6, '0')}`; // orders accepted before numbering existed
  const date = new Date(accepted?.created_at ?? o.created_at).toLocaleDateString('en-IN');

  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${invoiceNo}</title>
<style>body{font-family:Arial,sans-serif;color:#0B1F3A;margin:24px;max-width:820px}h1{margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left;font-size:13px}.r{text-align:right}.tot td{font-weight:700;border-top:2px solid #0B1F3A}
.row{display:flex;justify-content:space-between;gap:24px;margin-top:12px}.muted{color:#6B7788;font-size:12px}@media print{button{display:none}}</style></head><body>
<button onclick="window.print()">Print / Save as PDF</button>
<h1>TAX INVOICE</h1><div class="muted">${invoiceNo} &middot; ${esc(date)}</div>
${o.irn ? `<div class="muted">IRN: ${esc(o.irn)}<br>Ack no: ${esc(o.irn_ack_no)}${o.irn_ack_at ? ' &middot; ' + esc(new Date(o.irn_ack_at).toLocaleDateString('en-IN')) : ''}</div>` : ''}${o.eway_bill_no ? `<div class="muted">E-way bill: ${esc(o.eway_bill_no)}</div>` : ''}
<div class="row"><div><b>${esc(o.business_name)}</b><br>GSTIN: ${esc(o.gst_no ?? 'Not registered')}</div>
<div><b>Bill to</b><br>${esc(o.shop_name)}${o.retailer_gst_no ? '<br>GSTIN: ' + esc(o.retailer_gst_no) : ''}<br>${esc(o.address ?? '')} ${esc(o.pincode)}<br>${esc(o.retailer_phone)}</div></div>
<table><tr><th>Item</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">GST amt</th><th class="r">Amount</th></tr>${rows}
<tr class="tot"><td colspan="4">Total</td><td class="r">${fromPaise(taxable)}</td><td></td><td class="r">${fromPaise(gst)}</td><td class="r">${fromPaise(Number(o.total_paise))}</td></tr></table>
<p class="muted">${esc(taxNote)}<br>Amounts in INR. This is a computer-generated invoice.</p>
</body></html>`);
}));
