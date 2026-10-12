import { AppError } from './errors';

/** Parse "5000", "5000.5", "5000.50" or a number into integer paise. Rejects >2 decimals. */
export function toPaise(v: string | number): number {
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new AppError(400, 'BAD_AMOUNT', `Invalid amount: ${v}`);
  const [r, p = ''] = s.split('.');
  const paise = Number(r) * 100 + Number(p.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) throw new AppError(400, 'BAD_AMOUNT', 'Amount too large');
  return paise;
}

export function fromPaise(p: number): string {
  const neg = p < 0;
  const a = Math.abs(p);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Line total with GST (basis points) rounded half-up to paise. */
export const withGst = (basePaise: number, gstBps: number) =>
  basePaise + Math.round((basePaise * gstBps) / 10000);
