import { fromPaise } from '../../utils/money';

/**
 * Builders for the JSON the Indian GST portals take: the e-invoice (IRN) schema v1.1 and the e-way bill generation payload.
 * They are pure functions of the order, so they can be checked exhaustively. Nothing here talks to a government system;
 * submitting the JSON needs the distributor's GSP credentials (see gsp.ts).
 */
export interface Party { gstin: string | null; name: string; address: string | null; city: string | null; pincode: string | null; phone?: string | null; email?: string | null }
export interface Line { name: string; hsn: string | null; unit: string; qty: number; unit_price_paise: number; gst_rate_bps: number; line_total_paise: number }
export interface InvoiceInput { invoice_no: string | null; date: Date; seller: Party; buyer: Party; lines: Line[]; total_paise: number }

const GSTIN = /^\d{2}[A-Z0-9]{13}$/;
const SLABS = [0, 25, 300, 500, 1200, 1800, 2800];
const UQC: Record<string, string> = { pcs: 'PCS', kg: 'KGS', g: 'GMS', l: 'LTR', ml: 'MLT', box: 'BOX', carton: 'CTN', dozen: 'DOZ', pack: 'PAC', bag: 'BAG', bottle: 'BTL', set: 'SET' };
export const uqc = (unit: string) => UQC[unit.trim().toLowerCase()] ?? 'OTH';
export const stateOf = (gstin: string | null) => (gstin && GSTIN.test(gstin.trim().toUpperCase()) ? gstin.trim().slice(0, 2) : null);
const rupees = (paise: number) => Number((paise / 100).toFixed(2));
const ddmmyyyy = (d: Date) => {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  return `${String(ist.getUTCDate()).padStart(2, '0')}/${String(ist.getUTCMonth() + 1).padStart(2, '0')}/${ist.getUTCFullYear()}`;
};

/** Tax split for the whole invoice: same state => CGST + SGST (half each), different state => IGST. */
export function taxSplit(taxPaise: number, intra: boolean) {
  if (!intra) return { cgst: 0, sgst: 0, igst: taxPaise };
  const cgst = Math.floor(taxPaise / 2);
  return { cgst, sgst: taxPaise - cgst, igst: 0 };
}

function checkParty(side: 'Seller' | 'Buyer', p: Party, errors: string[]) {
  if (!p.gstin || !GSTIN.test(p.gstin.trim().toUpperCase())) errors.push(`${side}: a valid 15-character GSTIN is required`);
  if (!p.name?.trim()) errors.push(`${side}: legal name is required`);
  if (!p.address?.trim() || p.address.trim().length < 3) errors.push(`${side}: address is required`);
  if (!p.pincode || !/^\d{6}$/.test(p.pincode)) errors.push(`${side}: a 6-digit pincode is required`);
}

export function buildEInvoice(i: InvoiceInput) {
  const errors: string[] = []; const warnings: string[] = [];
  checkParty('Seller', i.seller, errors);
  if (!i.seller.city?.trim()) errors.push('Seller: city is required (add it in Business → Address)');
  if (!i.buyer.gstin) errors.push('Buyer has no GSTIN: e-invoicing is only for sales to GST-registered buyers (B2B). Ask the retailer to add their GSTIN.');
  else checkParty('Buyer', i.buyer, errors);
  if (!i.buyer.city?.trim()) warnings.push("Buyer's city is not on file, so the pincode is used as the place name");
  if (!i.invoice_no || !/^[A-Za-z0-9/\-]{1,16}$/.test(i.invoice_no)) errors.push('Invoice number must be 1-16 letters, digits, / or - (it is assigned when the order is accepted)');
  if (!i.lines.length) errors.push('The invoice has no items');
  i.lines.forEach((l, k) => {
    if (!l.hsn || !/^\d{4,8}$/.test(l.hsn)) errors.push(`Item ${k + 1} (${l.name}): HSN code (4 to 8 digits) is required`);
    if (!SLABS.includes(l.gst_rate_bps)) errors.push(`Item ${k + 1} (${l.name}): GST rate ${l.gst_rate_bps / 100}% is not a valid slab`);
  });

  const sellerState = stateOf(i.seller.gstin); const buyerState = stateOf(i.buyer.gstin);
  const intra = !!sellerState && sellerState === buyerState;

  let ass = 0, cg = 0, sg = 0, ig = 0, tot = 0;
  const items = i.lines.map((l, k) => {
    const base = l.unit_price_paise * l.qty; const tax = l.line_total_paise - base;
    const t = taxSplit(tax, intra);
    ass += base; cg += t.cgst; sg += t.sgst; ig += t.igst; tot += l.line_total_paise;
    return {
      SlNo: String(k + 1), PrdDesc: l.name.slice(0, 300), IsServc: 'N', HsnCd: l.hsn ?? '', Qty: l.qty, Unit: uqc(l.unit),
      UnitPrice: rupees(l.unit_price_paise), TotAmt: rupees(base), AssAmt: rupees(base), GstRt: l.gst_rate_bps / 100,
      IgstAmt: rupees(t.igst), CgstAmt: rupees(t.cgst), SgstAmt: rupees(t.sgst), TotItemVal: rupees(l.line_total_paise),
    };
  });
  if (tot !== i.total_paise) errors.push(`Items add up to ₹${fromPaise(tot)} but the order total is ₹${fromPaise(i.total_paise)}`);

  const party = (p: Party, state: string | null, pos?: boolean) => ({
    Gstin: (p.gstin ?? '').toUpperCase(), LglNm: p.name, ...(pos ? {} : { TrdNm: p.name }), ...(pos && { Pos: state ?? '' }),
    Addr1: (p.address ?? '').slice(0, 100), Loc: (p.city?.trim() || p.pincode || '').slice(0, 50), Pin: Number(p.pincode ?? 0), Stcd: state ?? '',
    ...(p.phone && /^\d{10}$/.test(p.phone) && { Ph: p.phone }), ...(p.email && { Em: p.email }),
  });

  const payload = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: i.invoice_no ?? '', Dt: ddmmyyyy(i.date) },
    SellerDtls: party(i.seller, sellerState),
    BuyerDtls: party(i.buyer, buyerState, true),
    ItemList: items,
    ValDtls: { AssVal: rupees(ass), CgstVal: rupees(cg), SgstVal: rupees(sg), IgstVal: rupees(ig), TotInvVal: rupees(tot) },
  };
  return { payload, errors, warnings, intra_state: intra };
}

export const EWAY_THRESHOLD_PAISE = 5_000_000; // ₹50,000: movement of goods above this value needs an e-way bill

export interface Transport { vehicle_no?: string; distance_km?: number; transporter_id?: string; transporter_name?: string }

export function buildEWayBill(i: InvoiceInput, t: Transport) {
  const inv = buildEInvoice(i);
  const errors = inv.errors.filter((e) => !e.startsWith('Buyer has no GSTIN'));      // an e-way bill may go to an unregistered buyer
  if (!i.buyer.gstin) errors.push('Buyer state can not be worked out without a GSTIN. Add the retailer\'s GSTIN.');
  const sellerState = stateOf(i.seller.gstin); const buyerState = stateOf(i.buyer.gstin);
  if (t.vehicle_no && !/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(t.vehicle_no)) errors.push('Vehicle number looks like MH12AB1234');
  if (t.transporter_id && !GSTIN.test(t.transporter_id)) errors.push('Transporter id must be a 15-character GSTIN');
  if (!t.vehicle_no && !t.transporter_id) errors.push('Give a vehicle number or a transporter id');
  if (!t.distance_km || t.distance_km < 1 || t.distance_km > 4000) errors.push('Distance in km (1 to 4000) is required');

  const v = inv.payload.ValDtls;
  const payload = {
    supplyType: 'O', subSupplyType: '1', docType: 'INV', docNo: i.invoice_no ?? '', docDate: inv.payload.DocDtls.Dt,
    fromGstin: (i.seller.gstin ?? '').toUpperCase(), fromTrdName: i.seller.name, fromAddr1: (i.seller.address ?? '').slice(0, 120), fromPlace: i.seller.city ?? '',
    fromPincode: Number(i.seller.pincode ?? 0), fromStateCode: Number(sellerState ?? 0), actFromStateCode: Number(sellerState ?? 0),
    toGstin: i.buyer.gstin ? i.buyer.gstin.toUpperCase() : 'URP', toTrdName: i.buyer.name, toAddr1: (i.buyer.address ?? '').slice(0, 120), toPlace: i.buyer.city?.trim() || i.buyer.pincode || '',
    toPincode: Number(i.buyer.pincode ?? 0), toStateCode: Number(buyerState ?? 0), actToStateCode: Number(buyerState ?? 0),
    transactionType: 1, totalValue: v.AssVal, cgstValue: v.CgstVal, sgstValue: v.SgstVal, igstValue: v.IgstVal, cessValue: 0, totInvValue: v.TotInvVal,
    transMode: '1', transDistance: String(t.distance_km ?? 0),
    ...(t.transporter_id && { transporterId: t.transporter_id }), ...(t.transporter_name && { transporterName: t.transporter_name }),
    ...(t.vehicle_no && { vehicleNo: t.vehicle_no, vehicleType: 'R' }),
    itemList: inv.payload.ItemList.map((it) => ({
      productName: it.PrdDesc, hsnCode: Number(it.HsnCd), quantity: it.Qty, qtyUnit: it.Unit, taxableAmount: it.AssAmt,
      sgstRate: inv.intra_state ? it.GstRt / 2 : 0, cgstRate: inv.intra_state ? it.GstRt / 2 : 0, igstRate: inv.intra_state ? 0 : it.GstRt, cessRate: 0,
    })),
  };
  return { payload, errors, warnings: inv.warnings, required: i.total_paise > EWAY_THRESHOLD_PAISE };
}
