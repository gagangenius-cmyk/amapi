import { Conn, q1 } from '../../db/pool';
import { AppError, forbidden } from '../../utils/errors';

export interface Permissions {
  self_delivery: boolean;
  khatabook_enabled: boolean;
  chat_enabled: boolean;
  notifications_enabled: boolean;
  pincode_selling: boolean;
  online_payments: boolean;
  employees_enabled: boolean;
  [k: string]: boolean;
}

export const DEFAULT_PERMISSIONS: Permissions = {
  self_delivery: true, khatabook_enabled: true, chat_enabled: true, notifications_enabled: true, pincode_selling: true, online_payments: true, employees_enabled: true,
};

/** What each switch does, in plain words (shown to the admin). */
export const PERMISSION_CATALOG: { key: keyof typeof DEFAULT_PERMISSIONS; label: string; help: string }[] = [
  { key: 'self_delivery', label: 'Own delivery', help: 'Assign orders to delivery staff and track them' },
  { key: 'khatabook_enabled', label: 'Khata book', help: 'Invoices, cash and online payments recorded in the retailer khata' },
  { key: 'chat_enabled', label: 'Chat', help: 'Chat with retailers' },
  { key: 'notifications_enabled', label: 'Offers & notifications', help: 'Send offers and news to retailers' },
  { key: 'pincode_selling', label: 'Sell by pincode', help: 'Retailers in the chosen pincodes can see the store without being connected' },
  { key: 'online_payments', label: 'Online payments', help: 'UPI and card payments from retailers' },
  { key: 'employees_enabled', label: 'Team members', help: 'Add employees under this distributor' },
];

export async function loadDistributor(c: Conn, distributorId: number) {
  const row = await q1<any>(c, 'SELECT * FROM distributor_profiles WHERE user_id = ?', [distributorId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Distributor not found');
  return { ...row, permissions: { ...DEFAULT_PERMISSIONS, ...JSON.parse(row.permissions) } as Permissions };
}

/** Throws unless the distributor's subscription is live. Call on every distributor-side write. */
export async function assertSubscriptionActive(c: Conn, distributorId: number) {
  const d = await loadDistributor(c, distributorId);
  if (new Date(d.subscription_ends_at).getTime() < Date.now())
    throw new AppError(402, 'SUBSCRIPTION_EXPIRED', 'Distributor subscription has expired');
  return d;
}

export async function assertPermission(c: Conn, distributorId: number, perm: string) {
  const d = await loadDistributor(c, distributorId);
  if (!d.permissions[perm]) throw forbidden(`Feature "${perm}" is disabled for this distributor`);
  return d;
}
