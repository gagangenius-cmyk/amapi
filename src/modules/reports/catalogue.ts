import { pool, q } from '../../db/pool';
import { fromPaise } from '../../utils/money';
import { Column, Row } from '../../utils/tabular';
import { Range } from './analytics';

/** Largest export. Anything beyond is cut and the job is marked `truncated`, so a spreadsheet is never silently incomplete. */
export const MAX_REPORT_ROWS = 100_000;

export interface ReportDef {
  type: string; title: string; description: string; usesRange: boolean;
  columns: Column[];
  rows(r: Range, distributorIds?: number[]): Promise<Row[]>;
}

const money = (v: unknown) => fromPaise(Math.round(Number(v ?? 0)));
const ts = (v: unknown) => (v ? new Date(v as string).toISOString().replace('T', ' ').slice(0, 19) : '');
const LIMIT = MAX_REPORT_ROWS + 1;   // one extra row tells us the cap was hit

const DELIVERED = `(SELECT order_id, MIN(created_at) at FROM order_events WHERE to_status = 'delivered' GROUP BY order_id)`;

export const REPORTS: ReportDef[] = [
  {
    type: 'orders', title: 'Orders', description: 'Every order placed in the period, with status, tax and delivery time.', usesRange: true,
    columns: [
      { key: 'id', header: 'Order', type: 'number' }, { key: 'created_at', header: 'Placed (UTC)' }, { key: 'delivered_at', header: 'Delivered (UTC)' },
      { key: 'distributor', header: 'Distributor' }, { key: 'retailer', header: 'Retailer' }, { key: 'pincode', header: 'Pincode' }, { key: 'status', header: 'Status' },
      { key: 'total', header: 'Total incl. GST (INR)', type: 'number' }, { key: 'tax', header: 'GST (INR)', type: 'number' },
      { key: 'outside', header: 'Outside hierarchy' }, { key: 'invoice_no', header: 'Invoice no.' },
    ],
    async rows(r, d) {
      const rows = await q<any>(pool, `
        SELECT o.id, o.created_at, e.at delivered_at, dp.business_name distributor, rp.shop_name retailer, rp.pincode, o.status, o.total_paise,
          COALESCE((SELECT SUM(oi.line_total_paise - oi.unit_price_paise * oi.qty) FROM order_items oi WHERE oi.order_id = o.id),0) tax,
          o.is_out_of_hierarchy, o.invoice_no
        FROM orders o JOIN distributor_profiles dp ON dp.user_id = o.distributor_id JOIN retailer_profiles rp ON rp.user_id = o.retailer_id
        LEFT JOIN ${DELIVERED} e ON e.order_id = o.id
        WHERE o.created_at BETWEEN ? AND ?${d ? ' AND o.distributor_id IN (?)' : ''} ORDER BY o.id LIMIT ${LIMIT}`, d ? [r.from, r.to, d] : [r.from, r.to]);
      return rows.map((o) => ({ id: o.id, created_at: ts(o.created_at), delivered_at: ts(o.delivered_at), distributor: o.distributor, retailer: o.retailer, pincode: o.pincode,
        status: o.status, total: money(o.total_paise), tax: money(o.tax), outside: o.is_out_of_hierarchy ? 'yes' : 'no', invoice_no: o.invoice_no ?? '' }));
    },
  },
  {
    type: 'products', title: 'Products and stock', description: 'The catalogue as it is now, with stock and low-stock flag.', usesRange: false,
    columns: [
      { key: 'distributor', header: 'Distributor' }, { key: 'name', header: 'Product' }, { key: 'sku', header: 'SKU' }, { key: 'category', header: 'Category' },
      { key: 'brand', header: 'Brand' }, { key: 'price', header: 'Price (INR)', type: 'number' }, { key: 'gst', header: 'GST %', type: 'number' },
      { key: 'stock', header: 'Stock', type: 'number' }, { key: 'threshold', header: 'Low-stock threshold', type: 'number' }, { key: 'low', header: 'Low stock' }, { key: 'active', header: 'Active' },
    ],
    async rows(_r, d) {
      const rows = await q<any>(pool, `SELECT dp.business_name distributor, p.name, p.sku, p.category, p.brand, p.price_paise, p.gst_rate_bps, p.stock_qty, p.low_stock_threshold, p.is_active
        FROM products p JOIN distributor_profiles dp ON dp.user_id = p.distributor_id WHERE p.deleted_at IS NULL${d ? ' AND p.distributor_id IN (?)' : ''}
        ORDER BY dp.business_name, p.name LIMIT ${LIMIT}`, d ? [d] : []);
      return rows.map((p) => ({ distributor: p.distributor, name: p.name, sku: p.sku ?? '', category: p.category ?? '', brand: p.brand ?? '', price: money(p.price_paise),
        gst: p.gst_rate_bps / 100, stock: p.stock_qty, threshold: p.low_stock_threshold, low: p.stock_qty <= p.low_stock_threshold ? 'yes' : 'no', active: p.is_active ? 'yes' : 'no' }));
    },
  },
  {
    type: 'inventory_movements', title: 'Stock movements', description: 'Every change to stock in the period: who, why, and the balance after.', usesRange: true,
    columns: [
      { key: 'at', header: 'When (UTC)' }, { key: 'distributor', header: 'Distributor' }, { key: 'product', header: 'Product' }, { key: 'delta', header: 'Change', type: 'number' },
      { key: 'balance', header: 'Balance after', type: 'number' }, { key: 'reason', header: 'Reason' }, { key: 'order', header: 'Order', type: 'number' }, { key: 'note', header: 'Note' },
    ],
    async rows(r, d) {
      const rows = await q<any>(pool, `SELECT sm.created_at, dp.business_name distributor, p.name product, sm.delta, sm.balance_after, sm.reason, sm.ref_order_id, sm.note
        FROM stock_movements sm JOIN products p ON p.id = sm.product_id JOIN distributor_profiles dp ON dp.user_id = sm.distributor_id
        WHERE sm.created_at BETWEEN ? AND ?${d ? ' AND sm.distributor_id IN (?)' : ''} ORDER BY sm.id LIMIT ${LIMIT}`, d ? [r.from, r.to, d] : [r.from, r.to]);
      return rows.map((m) => ({ at: ts(m.created_at), distributor: m.distributor, product: m.product, delta: m.delta, balance: m.balance_after, reason: m.reason, order: m.ref_order_id ?? '', note: m.note ?? '' }));
    },
  },
  {
    type: 'distributors', title: 'Distributors', description: 'Every distributor with subscription, network size and sales in the period.', usesRange: true,
    columns: [
      { key: 'business', header: 'Business' }, { key: 'owner', header: 'Owner' }, { key: 'phone', header: 'Phone' }, { key: 'city', header: 'City' },
      { key: 'active', header: 'Account active' }, { key: 'sub_end', header: 'Subscription ends (UTC)' }, { key: 'retailers', header: 'Retailers', type: 'number' },
      { key: 'orders', header: 'Orders in period', type: 'number' }, { key: 'gmv', header: 'GMV in period (INR)', type: 'number' }, { key: 'created_by', header: 'Created by' },
    ],
    async rows(r, d) {
      const rows = await q<any>(pool, `
        SELECT dp.business_name, u.name owner, u.phone, dp.city, u.is_active, dp.subscription_ends_at, cb.name created_by,
          (SELECT COUNT(*) FROM retailer_distributor_relations x WHERE x.distributor_id = dp.user_id AND x.status = 'active') retailers,
          (SELECT COUNT(*) FROM orders o WHERE o.distributor_id = dp.user_id AND o.created_at BETWEEN ? AND ?) orders,
          (SELECT COALESCE(SUM(o.total_paise),0) FROM orders o WHERE o.distributor_id = dp.user_id AND o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')) gmv
        FROM distributor_profiles dp JOIN users u ON u.id = dp.user_id LEFT JOIN users cb ON cb.id = u.created_by
        ${d ? 'WHERE dp.user_id IN (?)' : ''} ORDER BY dp.business_name LIMIT ${LIMIT}`, d ? [r.from, r.to, r.from, r.to, d] : [r.from, r.to, r.from, r.to]);
      return rows.map((x) => ({ business: x.business_name, owner: x.owner, phone: x.phone, city: x.city ?? '', active: x.is_active ? 'yes' : 'no', sub_end: ts(x.subscription_ends_at),
        retailers: Number(x.retailers), orders: Number(x.orders), gmv: money(x.gmv), created_by: x.created_by ?? '' }));
    },
  },
  {
    type: 'buyers', title: 'Retailers (buyers)', description: 'Every retailer with their orders in the period and what they owe now.', usesRange: true,
    columns: [
      { key: 'shop', header: 'Shop' }, { key: 'owner', header: 'Owner' }, { key: 'phone', header: 'Phone' }, { key: 'pincode', header: 'Pincode' },
      { key: 'joined', header: 'Joined (UTC)' }, { key: 'orders', header: 'Orders in period', type: 'number' }, { key: 'gmv', header: 'Spend in period (INR)', type: 'number' }, { key: 'owes', header: 'Owes now (INR)', type: 'number' },
    ],
    async rows(r, d) {
      const rows = await q<any>(pool, `
        SELECT rp.shop_name, u.name owner, u.phone, rp.pincode, u.created_at,
          (SELECT COUNT(*) FROM orders o WHERE o.retailer_id = u.id AND o.created_at BETWEEN ? AND ?${d ? ' AND o.distributor_id IN (?)' : ''}) orders,
          (SELECT COALESCE(SUM(o.total_paise),0) FROM orders o WHERE o.retailer_id = u.id AND o.created_at BETWEEN ? AND ? AND o.status NOT IN ('rejected','cancelled')${d ? ' AND o.distributor_id IN (?)' : ''}) gmv,
          (SELECT COALESCE(SUM(GREATEST(x.balance_due_paise,0)),0) FROM retailer_distributor_relations x WHERE x.retailer_id = u.id AND x.status = 'active'${d ? ' AND x.distributor_id IN (?)' : ''}) owes
        FROM users u JOIN retailer_profiles rp ON rp.user_id = u.id WHERE u.role = 'retailer'
        ${d ? 'AND EXISTS (SELECT 1 FROM retailer_distributor_relations z WHERE z.retailer_id = u.id AND z.distributor_id IN (?))' : ''}
        ORDER BY rp.shop_name LIMIT ${LIMIT}`,
        d ? [r.from, r.to, d, r.from, r.to, d, d, d] : [r.from, r.to, r.from, r.to]);
      return rows.map((x) => ({ shop: x.shop_name, owner: x.owner, phone: x.phone, pincode: x.pincode, joined: ts(x.created_at), orders: Number(x.orders), gmv: money(x.gmv), owes: money(x.owes) }));
    },
  },
  {
    type: 'payments', title: 'Payments collected', description: 'Cash and online payments recorded in the khata during the period.', usesRange: true,
    columns: [
      { key: 'at', header: 'When (UTC)' }, { key: 'distributor', header: 'Distributor' }, { key: 'retailer', header: 'Retailer' },
      { key: 'type', header: 'Type' }, { key: 'mode', header: 'Mode' }, { key: 'amount', header: 'Amount (INR)', type: 'number' }, { key: 'order', header: 'Order', type: 'number' },
    ],
    async rows(r, d) {
      const rows = await q<any>(pool, `SELECT lt.created_at, dp.business_name distributor, rp.shop_name retailer, lt.type, lt.payment_mode, lt.amount_paise, lt.order_id
        FROM ledger_transactions lt JOIN distributor_profiles dp ON dp.user_id = lt.distributor_id JOIN retailer_profiles rp ON rp.user_id = lt.retailer_id
        WHERE lt.type IN ('payment_cash','payment_online') AND lt.created_at BETWEEN ? AND ?${d ? ' AND lt.distributor_id IN (?)' : ''} ORDER BY lt.id LIMIT ${LIMIT}`, d ? [r.from, r.to, d] : [r.from, r.to]);
      return rows.map((x) => ({ at: ts(x.created_at), distributor: x.distributor, retailer: x.retailer, type: x.type, mode: x.payment_mode ?? '', amount: money(x.amount_paise), order: x.order_id ?? '' }));
    },
  },
  {
    type: 'receivables', title: 'Outstanding credit', description: 'What each retailer owes each distributor right now, with credit terms.', usesRange: false,
    columns: [
      { key: 'distributor', header: 'Distributor' }, { key: 'retailer', header: 'Retailer' }, { key: 'phone', header: 'Phone' }, { key: 'owes', header: 'Owes (INR)', type: 'number' },
      { key: 'limit', header: 'Credit limit (INR)', type: 'number' }, { key: 'days', header: 'Credit days', type: 'number' },
    ],
    async rows(_r, d) {
      const rows = await q<any>(pool, `SELECT dp.business_name distributor, rp.shop_name retailer, u.phone, x.balance_due_paise, x.credit_limit_paise, x.credit_days
        FROM retailer_distributor_relations x JOIN distributor_profiles dp ON dp.user_id = x.distributor_id JOIN retailer_profiles rp ON rp.user_id = x.retailer_id JOIN users u ON u.id = x.retailer_id
        WHERE x.status = 'active' AND x.balance_due_paise <> 0${d ? ' AND x.distributor_id IN (?)' : ''} ORDER BY x.balance_due_paise DESC LIMIT ${LIMIT}`, d ? [d] : []);
      return rows.map((x) => ({ distributor: x.distributor, retailer: x.retailer, phone: x.phone, owes: money(x.balance_due_paise), limit: x.credit_limit_paise == null ? '' : money(x.credit_limit_paise), days: x.credit_days }));
    },
  },
  {
    type: 'commissions', title: 'Commissions', description: 'Commission earned (net of reversals for approved returns) in the period, per distributor, from the commission ledger.', usesRange: true,
    columns: [
      { key: 'distributor', header: 'Distributor' }, { key: 'orders', header: 'Orders', type: 'number' }, { key: 'gross', header: 'Commission base excl. GST (INR)', type: 'number' }, { key: 'commission', header: 'Commission (INR)', type: 'number' },
    ],
    async rows(r, d) {
      const rows = await q<any>(pool, `
        SELECT dp.business_name distributor, COUNT(DISTINCT e.order_id) orders, COALESCE(SUM(CASE WHEN e.kind <> 'reversal' THEN e.basis_paise END),0) gross, SUM(e.amount_paise) commission
        FROM commission_entries e JOIN distributor_profiles dp ON dp.user_id = e.distributor_id
        WHERE e.occurred_at BETWEEN ? AND ?${d ? ' AND e.distributor_id IN (?)' : ''}
        GROUP BY e.distributor_id, dp.business_name ORDER BY commission DESC LIMIT ${LIMIT}`, d ? [r.from, r.to, d] : [r.from, r.to]);
      return rows.map((x) => ({ distributor: x.distributor, orders: Number(x.orders), gross: money(x.gross), commission: money(x.commission) }));
    },
  },
];

export const reportByType = (t: string) => REPORTS.find((r) => r.type === t);
