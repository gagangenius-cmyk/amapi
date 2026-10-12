import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Conn, exec, pool, q, q1, withTx } from '../../db/pool';
import { AppError, forbidden } from '../../utils/errors';
import { DEFAULT_PERMISSIONS, PERMISSION_CATALOG } from '../distributors/subscription';
import { GRANTABLE_KEYS } from './permissions';

const phone = z.string().regex(/^\d{10}$/, '10-digit phone');
const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters');

export const distributorBody = z.object({
  phone, name: z.string().trim().min(2).max(120), password: z.string().min(8).max(100),
  email: z.string().trim().toLowerCase().email().max(190).optional(),
  business_name: z.string().trim().min(2).max(190), gst_no: gstin.optional(),
  address: z.string().trim().min(3).max(255).optional(), city: z.string().trim().min(2).max(100).optional(),
  pincode: z.string().regex(/^\d{6}$/, 'Pincode is 6 digits').optional(),
  permissions: z.record(z.string(), z.boolean()).optional(),
  subscription_days: z.number().int().min(1).max(365).optional(),
});

export const TRIAL_DAYS = 30;

/** Turn a "phone/email already used" database error into the clean 409 the app shows. */
export function dupToConflict(e: any): never {
  if (e?.code === 'ER_DUP_ENTRY') {
    const email = String(e.message).includes('uq_users_email');
    throw new AppError(409, email ? 'EMAIL_TAKEN' : 'PHONE_TAKEN', `${email ? 'Email' : 'Phone'} already registered`);
  }
  throw e;
}

/** Phone and email must be free. An unverified email does not reserve the address (same rule as sign-up). */
export async function assertIdentityFree(c: Conn, phone: string, email?: string | null) {
  if (await q1(c, 'SELECT id FROM users WHERE phone = ?', [phone])) throw new AppError(409, 'PHONE_TAKEN', 'Phone already registered');
  if (email) {
    await exec(c, 'UPDATE users SET email = NULL WHERE email = ? AND email_verified_at IS NULL', [email]);
    if (await q1(c, 'SELECT id FROM users WHERE email = ?', [email])) throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
  }
}

/**
 * Feature switches for a new or edited distributor.
 * `allowed` = null: the creator is the admin and may set any switch. Otherwise the creator is a company employee and may
 * only set the switches the admin gave them; asking for any other is refused, and the rest start switched off.
 */
export function resolvePermissions(requested: Record<string, boolean> | undefined, allowed: string[] | null, base: Record<string, boolean> | null): Record<string, boolean> {
  const wanted = Object.entries(requested ?? {});
  const unknown = wanted.filter(([k]) => !GRANTABLE_KEYS.includes(k)).map(([k]) => k);
  if (unknown.length) throw new AppError(400, 'UNKNOWN_PERMISSION', `Unknown permission: ${unknown.join(', ')}`);
  if (allowed) {
    const denied = wanted.filter(([k]) => !allowed.includes(k)).map(([k]) => k);
    if (denied.length) throw forbidden(`You cannot grant: ${denied.join(', ')}`);
  }
  const start = base ?? (allowed ? Object.fromEntries(GRANTABLE_KEYS.map((k) => [k, allowed.includes(k)])) : { ...DEFAULT_PERMISSIONS });
  return { ...start, ...Object.fromEntries(wanted) };
}

export async function createDistributorAccount(b: z.infer<typeof distributorBody>, createdBy: number, allowed: string[] | null) {
  const permissions = resolvePermissions(b.permissions, allowed, null);
  const hash = await bcrypt.hash(b.password, 10);
  // only the admin chooses the subscription length; everyone else opens the standard trial
  const days = allowed ? TRIAL_DAYS : b.subscription_days ?? TRIAL_DAYS;
  try {
    return await withTx(async (c) => {
      await assertIdentityFree(c, b.phone, b.email);
      const u = await exec(c, "INSERT INTO users (role, phone, email, name, password_hash, created_by) VALUES ('distributor',?,?,?,?,?)", [b.phone, b.email ?? null, b.name, hash, createdBy]);
      await exec(c, `INSERT INTO distributor_profiles (user_id, business_name, gst_no, address, city, pincode, permissions, subscription_ends_at)
        VALUES (?,?,?,?,?,?,?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))`, [u.insertId, b.business_name, b.gst_no ?? null, b.address ?? null, b.city ?? null, b.pincode ?? null, JSON.stringify(permissions), days]);
      return { id: u.insertId as number, permissions };
    });
  } catch (e) { return dupToConflict(e); }
}

/** One row per distributor, shaped the same for the admin console and the company employee's app. */
export async function listDistributors(where: string, args: unknown[]) {
  const rows = await q<any>(pool, `
    SELECT dp.user_id id, dp.business_name, dp.plan_name, dp.city, dp.pincode, u.name owner_name, u.phone, u.is_active, u.created_by, cb.name created_by_name,
      dp.subscription_ends_at, dp.permissions, dp.commission_rate_bps,
      (SELECT COUNT(*) FROM retailer_distributor_relations r WHERE r.distributor_id = dp.user_id) retailers,
      (SELECT COUNT(*) FROM orders o WHERE o.distributor_id = dp.user_id) orders
    FROM distributor_profiles dp JOIN users u ON u.id = dp.user_id LEFT JOIN users cb ON cb.id = u.created_by
    WHERE ${where} ORDER BY dp.subscription_ends_at`, args);
  return rows.map((r) => ({
    ...r, is_active: !!r.is_active, permissions: { ...DEFAULT_PERMISSIONS, ...JSON.parse(r.permissions) },
    retailers: Number(r.retailers), orders: Number(r.orders),
  }));
}

/** Commission per distributor, from the commission entries (net of reversals): the same figures the settlements are built from. */
export async function commissionReport() {
  const rows = await q<any>(pool, `
    SELECT t.distributor_id, dp.business_name, COUNT(*) orders, SUM(t.gross) gross_paise, SUM(t.commission) commission_paise
    FROM (SELECT e.distributor_id, e.order_id, o.total_paise gross, SUM(e.amount_paise) commission
          FROM commission_entries e JOIN orders o ON o.id = e.order_id GROUP BY e.distributor_id, e.order_id, o.total_paise) t
    JOIN distributor_profiles dp ON dp.user_id = t.distributor_id GROUP BY t.distributor_id, dp.business_name`);
  return rows.map((r) => ({ ...r, orders: Number(r.orders), gross_paise: Number(r.gross_paise), commission_paise: Number(r.commission_paise) }));
}

export const grantCatalog = (keys: string[]) => PERMISSION_CATALOG.filter((p) => keys.includes(p.key as string));
