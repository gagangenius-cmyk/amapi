/**
 * Receivables, derived from ledger rows (never stored, so it can not drift from the ledger).
 * Charges (delta > 0) fall due `creditDays` after they were posted. Credits (delta < 0: payments, credit notes) are applied to the
 * OLDEST open charge first (FIFO). A reversal cancels exactly the entry it points at: both disappear from the picture,
 * so a cancelled invoice never eats a payment that belongs to another invoice.
 */
export interface AgingEntry {
  id?: number; reversal_of?: number | null; order_id?: number | null; type?: string;
  delta_paise: number; created_at: Date | string;
}

export interface Aging {
  not_due: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  overdue: number; total_due: number; advance: number; oldest_overdue_days: number;
}

export interface InvoiceLine {
  id: number | null; type: string | null; order_id: number | null;
  amount: number; paid: number; outstanding: number;
  created_at: Date; due_at: Date; days_overdue: number;
  status: 'paid' | 'partial' | 'unpaid' | 'overdue' | 'cancelled';
}

const DAY = 86_400_000;

/** Split off cancelled entries: returns what still counts, and the ids that were cancelled by a reversal. */
export function normalize(entries: AgingEntry[]) {
  const reversed = new Set<number>();
  for (const e of entries) if (e.reversal_of != null) reversed.add(Number(e.reversal_of));
  const live = entries.filter((e) => e.reversal_of == null && !(e.id != null && reversed.has(Number(e.id))));
  const cancelled = entries.filter((e) => e.id != null && reversed.has(Number(e.id)) && Number(e.delta_paise) > 0);
  return { live, cancelled };
}

/** Every charge with how much of it has been paid, oldest payments first. */
export function invoiceLines(entries: AgingEntry[], now: Date, creditDays: number) {
  const { live, cancelled } = normalize(entries);
  const sorted = [...live].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at) || (a.id ?? 0) - (b.id ?? 0));
  const lines: InvoiceLine[] = [];
  let credit = 0;
  for (const e of sorted) {
    const d = Number(e.delta_paise);
    if (d > 0) {
      const at = new Date(e.created_at);
      lines.push({ id: e.id ?? null, type: e.type ?? null, order_id: e.order_id ?? null, amount: d, paid: 0, outstanding: d, created_at: at, due_at: new Date(+at + creditDays * DAY), days_overdue: 0, status: 'unpaid' });
    } else credit += -d;
  }
  for (const ch of lines) {
    const take = Math.min(ch.outstanding, credit);
    ch.paid = take; ch.outstanding -= take; credit -= take;
    const days = Math.floor((+now - +ch.due_at) / DAY);
    ch.days_overdue = ch.outstanding > 0 && days >= 1 ? days : 0;
    ch.status = ch.outstanding === 0 ? 'paid' : ch.days_overdue > 0 ? 'overdue' : ch.paid > 0 ? 'partial' : 'unpaid';
  }
  const gone: InvoiceLine[] = cancelled.map((e) => ({
    id: e.id ?? null, type: e.type ?? null, order_id: e.order_id ?? null, amount: Number(e.delta_paise), paid: 0, outstanding: 0,
    created_at: new Date(e.created_at), due_at: new Date(e.created_at), days_overdue: 0, status: 'cancelled',
  }));
  return { lines, cancelled: gone, advance: credit };
}

export function computeAging(entries: AgingEntry[], now: Date, creditDays: number): Aging {
  const { lines, advance } = invoiceLines(entries, now, creditDays);
  const a: Aging = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 0, total_due: 0, advance, oldest_overdue_days: 0 };
  for (const ch of lines) {
    if (ch.outstanding <= 0) continue;
    a.total_due += ch.outstanding;
    // Late only once a whole day has passed since the due moment: an invoice issued today with 0 credit days is "due now", not "1 day late".
    const days = ch.days_overdue;
    if (days < 1) a.not_due += ch.outstanding;
    else {
      a.overdue += ch.outstanding;
      a.oldest_overdue_days = Math.max(a.oldest_overdue_days, days);
      if (days <= 30) a.d1_30 += ch.outstanding; else if (days <= 60) a.d31_60 += ch.outstanding; else if (days <= 90) a.d61_90 += ch.outstanding; else a.d90_plus += ch.outstanding;
    }
  }
  return a;
}
