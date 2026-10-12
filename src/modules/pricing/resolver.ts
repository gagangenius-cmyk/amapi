import { Conn, q } from '../../db/pool';
import { priceForQty, Tier } from '../catalog/stock';

/**
 * PRICE PRECEDENCE (the one place it is defined)
 *
 * For one retailer, one product and one quantity, on one date:
 *
 *  1. Standard price: the product's base price, or its quantity break (tier) price when the quantity reaches one.
 *  2. Candidate list prices: every price list that is active, inside its date window, and applies to this retailer
 *     (the retailer is a member, or it is a regional list and the retailer's pincode starts with one of its prefixes).
 *     Within one list, the row with the largest min_qty that the quantity reaches is that list's candidate.
 *     A "fixed" row is that price. A "percent_off" row is taken off the STANDARD price for this quantity (so a % discount
 *     builds on the quantity break).
 *  3. A list price above the standard price is capped at the standard price, unless the list has allow_above_standard.
 *  4. The winner is chosen by, in order:
 *       a. kind:      contract (this customer) > promotion > group > regional
 *       b. priority:  the higher number
 *       c. price:     the lower unit price
 *       d. list id:   the lower id (so the answer never depends on row order)
 *     Only the winner applies: price lists never stack. A more specific list wins even when a less specific one is cheaper.
 *  5. If no list wins (or the winner would not change the price), the standard price applies.
 *
 * The result is a unit price in paise; GST is added on top by the caller, exactly as before.
 */
export type ListKind = 'contract' | 'promotion' | 'group' | 'regional';
export const KIND_RANK: Record<ListKind, number> = { contract: 1, promotion: 2, group: 3, regional: 4 };

export interface Rule {
  list_id: number; list_name: string; kind: ListKind; priority: number; allow_above: boolean;
  mode: 'fixed' | 'percent_off'; value: number; min_qty: number;
}

export interface Resolved {
  unit_paise: number;
  standard_paise: number;
  basis: 'standard' | 'tier' | 'list';
  list_id: number | null;
  list_name: string | null;
  kind: ListKind | null;
  /** every list that had a price for this quantity, in the order they were ranked (winner first) */
  considered: { list_id: number; list_name: string; kind: ListKind; priority: number; unit_paise: number; capped: boolean }[];
}

export function resolvePrice(basePaise: number, tiers: Tier[], rules: Rule[], qty: number): Resolved {
  const standard = priceForQty(basePaise, tiers, qty);
  const stdBasis: 'standard' | 'tier' = standard === basePaise ? 'standard' : 'tier';

  const perList = new Map<number, Rule>();
  for (const r of rules) {
    if (r.min_qty > qty) continue;
    const cur = perList.get(r.list_id);
    if (!cur || r.min_qty > cur.min_qty) perList.set(r.list_id, r);
  }
  const ranked = [...perList.values()].map((r) => {
    const raw = r.mode === 'fixed' ? r.value : Math.round((standard * (10000 - r.value)) / 10000);
    const capped = !r.allow_above && raw > standard;
    return { r, unit: Math.max(0, capped ? standard : raw), capped };
  }).sort((a, b) =>
    KIND_RANK[a.r.kind] - KIND_RANK[b.r.kind] || b.r.priority - a.r.priority || a.unit - b.unit || a.r.list_id - b.r.list_id);

  const considered = ranked.map((x) => ({ list_id: x.r.list_id, list_name: x.r.list_name, kind: x.r.kind, priority: x.r.priority, unit_paise: x.unit, capped: x.capped }));
  const win = ranked[0];
  if (!win || win.unit === standard) return { unit_paise: standard, standard_paise: standard, basis: stdBasis, list_id: null, list_name: null, kind: null, considered };
  return { unit_paise: win.unit, standard_paise: standard, basis: 'list', list_id: win.r.list_id, list_name: win.r.list_name, kind: win.r.kind, considered };
}

/** The price list rows that apply to this retailer today, grouped by product. */
export async function loadRules(c: Conn, o: { distributorId: number; retailerId: number; pincode?: string | null; productIds: number[]; onDate?: string }): Promise<Map<number, Rule[]>> {
  const out = new Map<number, Rule[]>();
  if (!o.productIds.length) return out;
  const day = o.onDate ?? new Date().toISOString().slice(0, 10);
  const rows = await q<any>(c, `
    SELECT pl.id list_id, pl.name list_name, pl.kind, pl.priority, pl.allow_above_standard, pl.pincode_prefixes,
      pli.product_id, pli.mode, pli.value, pli.min_qty,
      EXISTS (SELECT 1 FROM price_list_members m WHERE m.price_list_id = pl.id AND m.retailer_id = ?) is_member
    FROM price_lists pl JOIN price_list_items pli ON pli.price_list_id = pl.id
    WHERE pl.distributor_id = ? AND pl.is_active = 1
      AND (pl.valid_from IS NULL OR pl.valid_from <= ?) AND (pl.valid_to IS NULL OR pl.valid_to >= ?)
      AND pli.product_id IN (?)`, [o.retailerId, o.distributorId, day, day, o.productIds]);

  for (const r of rows) {
    let applies = !!r.is_member;
    if (!applies && r.kind === 'regional' && o.pincode) {
      try { applies = (JSON.parse(r.pincode_prefixes ?? '[]') as string[]).some((p) => p && o.pincode!.startsWith(p)); } catch { applies = false; }
    }
    if (!applies) continue;
    const rule: Rule = {
      list_id: r.list_id, list_name: r.list_name, kind: r.kind, priority: r.priority, allow_above: !!r.allow_above_standard,
      mode: r.mode, value: Number(r.value), min_qty: r.min_qty,
    };
    const arr = out.get(r.product_id) ?? [];
    arr.push(rule);
    out.set(r.product_id, arr);
  }
  return out;
}

/**
 * The retailer's whole price table for a product: the price at quantity 1, and a break wherever the price changes.
 * It has the same shape as the standard `tiers`, so a screen that computes "price for quantity" needs no new logic.
 */
export function effectiveTable(basePaise: number, tiers: Tier[], rules: Rule[]): { base: Resolved; breaks: { min_qty: number; resolved: Resolved }[] } {
  const points = new Set<number>([1]);
  for (const t of tiers) points.add(t.min_qty);
  for (const r of rules) points.add(Math.max(1, r.min_qty));
  const sorted = [...points].sort((a, b) => a - b);
  const base = resolvePrice(basePaise, tiers, rules, 1);
  const breaks: { min_qty: number; resolved: Resolved }[] = [];
  let prev = base.unit_paise;
  for (const qty of sorted) {
    if (qty === 1) continue;
    const r = resolvePrice(basePaise, tiers, rules, qty);
    if (r.unit_paise !== prev) breaks.push({ min_qty: qty, resolved: r });
    prev = r.unit_paise;
  }
  return { base, breaks };
}
