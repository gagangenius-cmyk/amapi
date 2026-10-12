/**
 * Hand an e-invoice to a GST Suvidha Provider (GSP) and read back the IRN. GSPs differ in how they authenticate and in field
 * names, so this adapter speaks the simplest common shape: POST the NIC JSON, receive {Irn, AckNo, AckDt, SignedQRCode}.
 * Set EINVOICE_GSP_URL (and EINVOICE_GSP_TOKEN). Without them the app still builds the JSON for upload on the government portal.
 */
export interface IrnResult { irn: string; ackNo: string; ackDate: Date; signedQr: string | null }

export const gspConfigured = () => !!process.env.EINVOICE_GSP_URL;

export async function submitEInvoice(payload: unknown): Promise<IrnResult> {
  const url = process.env.EINVOICE_GSP_URL;
  if (!url) throw new Error('No GSP configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.EINVOICE_GSP_TOKEN && { Authorization: `Bearer ${process.env.EINVOICE_GSP_TOKEN}` }) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await res.json().catch(() => ({}));
  const d = j?.data ?? j;                                   // some providers wrap the result
  const irn = d.Irn ?? d.irn; const ackNo = d.AckNo ?? d.ack_no ?? d.ackNo; const ackDt = d.AckDt ?? d.ack_date ?? d.ackDt;
  if (!res.ok || !irn) throw new Error(`GSP rejected the invoice: ${j?.message ?? j?.error?.message ?? j?.ErrorDetails?.[0]?.ErrorMessage ?? res.status}`);
  if (!/^[a-f0-9]{64}$/i.test(irn)) throw new Error('GSP returned an IRN in an unexpected format');
  const when = ackDt ? new Date(String(ackDt).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(ackDt)) ? '' : '+05:30')) : new Date();
  return { irn: irn.toLowerCase(), ackNo: String(ackNo ?? ''), ackDate: Number.isNaN(+when) ? new Date() : when, signedQr: d.SignedQRCode ?? d.signed_qr ?? null };
}
