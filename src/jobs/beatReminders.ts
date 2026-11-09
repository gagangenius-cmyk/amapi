import { exec, pool, q, q1 } from '../db/pool';
import { fromPaise } from '../utils/money';
import { notifyUsers } from '../services/notify';

const IST_MS = 5.5 * 3600_000;

/**
 * The evening before a beat, tell every retailer on tomorrow's beats who will come to collect, how much is pending and which
 * bills it is made of. A retailer is told once per day however many beats list them. Retailers that owe nothing are skipped.
 */
export async function runBeatReminders(now = new Date()) {
  const tomorrow = new Date(now.getTime() + IST_MS + 86400_000).getUTCDay();   // 0 = Sunday, in India time
  const rows = await q<any>(pool, `SELECT bp.distributor_id, bp.employee_id, e.name employee_name, dp.business_name, bpr.retailer_id, rdr.balance_due_paise
    FROM beat_plans bp
    JOIN beat_plan_retailers bpr ON bpr.beat_id = bp.id
    JOIN users e ON e.id = bp.employee_id AND e.is_active = 1
    JOIN distributor_profiles dp ON dp.user_id = bp.distributor_id
    JOIN retailer_distributor_relations rdr ON rdr.distributor_id = bp.distributor_id AND rdr.retailer_id = bpr.retailer_id AND rdr.status = 'active'
    WHERE bp.weekday = ? AND bp.is_active = 1 AND rdr.balance_due_paise > 0`, [tomorrow]);
  let sent = 0;
  for (const r of rows) {
    const done = await q1(pool, "SELECT 1 FROM collection_reminders WHERE distributor_id = ? AND retailer_id = ? AND source = 'beat' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 HOUR)", [r.distributor_id, r.retailer_id]);
    if (done) continue;
    const due = Number(r.balance_due_paise);
    // the newest bills, until they add up to what is owed
    const bills = await q<any>(pool, `SELECT invoice_no, total_paise FROM orders WHERE retailer_id = ? AND distributor_id = ? AND invoice_no IS NOT NULL AND status IN ('accepted','dispatched','out_for_delivery','delivered') ORDER BY id DESC LIMIT 20`, [r.retailer_id, r.distributor_id]);
    const nos: string[] = []; let covered = 0;
    for (const b of bills) { if (covered >= due) break; nos.push(b.invoice_no); covered += Number(b.total_paise); }
    await exec(pool, "INSERT INTO collection_reminders (distributor_id, retailer_id, amount_paise, source) VALUES (?,?,?,'beat')", [r.distributor_id, r.retailer_id, due]);
    notifyUsers([r.retailer_id], 'Collection visit tomorrow',
      `${r.employee_name} from ${r.business_name} will visit tomorrow to collect ₹${fromPaise(due)}${nos.length ? `. Bills: ${nos.join(', ')}` : ''}.`, { type: 'khata', id: r.distributor_id });
    sent++;
  }
  return sent;
}
