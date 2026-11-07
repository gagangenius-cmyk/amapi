/**
 * The same product can be printed or typed as UPC-A (12 digits) or EAN-13 (the same digits with a leading 0), and scanners report either.
 * Returns every form worth matching so a scan finds the product however its barcode was saved. Non-numeric codes (Code 128/39) match as typed.
 */
export function barcodeForms(code: string): string[] {
  const c = String(code ?? '').trim();
  if (!/^\d+$/.test(c)) return [c];
  const forms = new Set([c]);
  if (c.length === 12) forms.add('0' + c);
  if (c.length === 13 && c.startsWith('0')) forms.add(c.slice(1));
  return [...forms];
}
