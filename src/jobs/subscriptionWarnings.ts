import cron from 'node-cron';
import { exec, lockName, pool, q } from '../db/pool';
import { logger } from '../utils/logger';
import { checkReceipts, flushOutbox, notifyUsers } from '../services/notify';
import { receivablesOf, sendReminder } from '../modules/collections/collections.routes';

/**
 * Subscription warnings. In the last `days` days a distributor is told every day how long is left (one push a day, however often this
 * runs); when the subscription ends they are told once that it has ended. Paying resets the counter (expiry_warned_at = NULL).
 */
export async function runExpiryWarnings(days = 5) {
  const soon = await q<any>(pool, `
    SELECT user_id, subscription_ends_at FROM distributor_profiles
    WHERE subscription_ends_at > UTC_TIMESTAMP() AND subscription_ends_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY)
      AND (expiry_warned_at IS NULL OR expiry_warned_at < UTC_DATE())`, [days]);
  for (const d of soon) {
    const left = Math.max(1, Math.ceil((+new Date(d.subscription_ends_at) - Date.now()) / 86_400_000));
    notifyUsers([d.user_id], left <= 1 ? 'Subscription ends today' : `Subscription ends in ${left} days`,
      `Your AAYME subscription ends on ${new Date(d.subscription_ends_at).toLocaleDateString('en-IN')}. Renew now to keep taking orders. Open Business → Subscription.`, { type: 'subscription' });
    await exec(pool, 'UPDATE distributor_profiles SET expiry_warned_at = UTC_TIMESTAMP() WHERE user_id = ?', [d.user_id]);
    await exec(pool, "INSERT INTO audit_log (action, entity, entity_id, meta) VALUES ('subscription.expiry_warning','distributor',?,?)", [d.user_id, JSON.stringify({ ends_at: d.subscription_ends_at, days_left: left })]);
  }
  const ended = await q<any>(pool, `
    SELECT user_id, subscription_ends_at FROM distributor_profiles
    WHERE subscription_ends_at <= UTC_TIMESTAMP() AND subscription_ends_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
      AND (expiry_warned_at IS NULL OR expiry_warned_at < subscription_ends_at)`);
  for (const d of ended) {
    notifyUsers([d.user_id], 'Subscription ended', 'Your AAYME subscription has ended, so new orders and changes are paused. Renew in Business → Subscription to continue.', { type: 'subscription' });
    await exec(pool, 'UPDATE distributor_profiles SET expiry_warned_at = UTC_TIMESTAMP() WHERE user_id = ?', [d.user_id]);
    await exec(pool, "INSERT INTO audit_log (action, entity, entity_id, meta) VALUES ('subscription.expired_notice','distributor',?,?)", [d.user_id, JSON.stringify({ ended_at: d.subscription_ends_at })]);
  }
  return [...soon, ...ended].map((d) => d.user_id as number);
}

/**
 * Daily gentle nudge to retailers whose payment is past its due date (credit_days). Distributors with credit_days = 0 and
 * khatabook on are included only when something is overdue by at least a day. One reminder per pair per 24 h at most.
 */
export async function runOverdueReminders(now = new Date()) {
  const dists = await q<any>(pool, "SELECT user_id, business_name, permissions FROM distributor_profiles WHERE subscription_ends_at > UTC_TIMESTAMP()");
  let sent = 0;
  for (const d of dists) {
    if (JSON.parse(d.permissions).khatabook_enabled === false) continue;
    for (const { rel, aging } of await receivablesOf(d.user_id, now)) {
      if (aging.oldest_overdue_days < 1 || aging.overdue <= 0) continue;
      if (await sendReminder(d.user_id, d.business_name, rel.retailer_id, aging.overdue, 'auto', true)) sent++;
    }
  }
  return sent;
}

/** Daily heads-up to distributors whose batches are expired or expire within `days`. One summary per distributor. */
export async function runBatchExpiryAlerts(days = 14) {
  const rows = await q<any>(pool, `SELECT distributor_id, COUNT(*) batches, SUM(expiry_date < UTC_DATE()) expired
    FROM product_batches WHERE qty_remaining > 0 AND expiry_date IS NOT NULL AND expiry_date <= DATE_ADD(UTC_DATE(), INTERVAL ? DAY) GROUP BY distributor_id`, [days]);
  for (const r of rows) {
    const expired = Number(r.expired);
    notifyUsers([r.distributor_id], expired ? 'Expired stock' : 'Stock expiring soon',
      expired ? `${expired} batch${expired === 1 ? ' is' : 'es are'} expired and ${Number(r.batches) - expired} more expire within ${days} days.` : `${r.batches} batch${Number(r.batches) === 1 ? '' : 'es'} expire within ${days} days.`, { type: 'expiry' });
  }
  return rows.length;
}

/** Run a job on at most one server at a time using a MySQL advisory lock (safe with many API instances). */
async function withLock(name: string, fn: () => Promise<unknown>) {
  const c = await pool.getConnection();
  try {
    const [rows] = await c.query<any[]>('SELECT GET_LOCK(?, 0) AS got', [lockName(name)]);
    if (!rows[0].got) return;
    try { await fn(); } finally { await c.query('SELECT RELEASE_LOCK(?)', [lockName(name)]); }
  } finally {
    c.release();
  }
}

/** Delete rows that can never be used again, so these tables do not grow forever. */
export async function runCleanup() {
  const tokens = await exec(pool, 'DELETE FROM refresh_tokens WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) OR revoked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)');
  const otps = await exec(pool, 'DELETE FROM otps WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
  const pushes = await exec(pool, "DELETE FROM push_outbox WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY) AND status <> 'pending'");
  return { refresh_tokens: tokens.affectedRows, otps: otps.affectedRows, push_outbox: pushes.affectedRows };
}

export function startJobs() {
  // Push queue: retry what failed every minute; ask Expo about delivery every 10 minutes.
  cron.schedule('* * * * *', () => { flushOutbox().catch((err) => logger.error({ err }, 'push retry failed')); });
  cron.schedule('*/10 * * * *', () => { checkReceipts().catch((err) => logger.error({ err }, 'push receipts failed')); });
  cron.schedule('30 3 * * *', () => withLock('aymee_cleanup_job', async () => { logger.info(await runCleanup(), 'cleanup'); }).catch((err) => logger.error({ err }, 'cleanup job failed')));
  cron.schedule('0 10 * * *', () => withLock('aymee_overdue_job', async () => { logger.info({ sent: await runOverdueReminders() }, 'overdue reminders'); }).catch((err) => logger.error({ err }, 'overdue job failed')));
  cron.schedule('15 9 * * *', () => withLock('aymee_batch_expiry_job', async () => { logger.info({ distributors: await runBatchExpiryAlerts() }, 'batch expiry alerts'); }).catch((err) => logger.error({ err }, 'batch expiry job failed')));
  cron.schedule('0 9 * * *', () => withLock('aymee_expiry_job', runExpiryWarnings).catch((err) => logger.error({ err }, 'expiry job failed')));
}
