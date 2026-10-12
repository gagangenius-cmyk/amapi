import { NextFunction, Request, Response } from 'express';
import { pool, q1 } from '../../db/pool';
import { forbidden } from '../../utils/errors';
import { PERMISSION_CATALOG } from '../distributors/subscription';

/**
 * What a company employee may DO. The admin switches these per person.
 * To add a new power: add a line here, then guard the route with requireStaffAction('<key>').
 */
export const STAFF_ACTIONS = [
  { key: 'create_distributors', label: 'Create distributors', help: 'Open new distributor accounts' },
  { key: 'manage_distributors', label: 'Manage their distributors', help: 'Change feature switches, extend the subscription, suspend or restore distributors they created' },
  { key: 'view_all_distributors', label: 'See every distributor', help: 'Read-only list of all distributors, not only the ones they created' },
  { key: 'view_commissions', label: 'See commissions', help: 'Read the out-of-hierarchy commission report' },
  { key: 'handle_support', label: 'Handle support tickets', help: 'Answer, assign and resolve tickets raised by retailers and distributors' },
  { key: 'support_reports', label: 'See support performance', help: 'Response times, SLA compliance and satisfaction' },
] as const;

export type StaffAction = (typeof STAFF_ACTIONS)[number]['key'];
const ACTION_KEYS: string[] = STAFF_ACTIONS.map((a) => a.key);
/** Feature switches a distributor can have; a company employee can hand out only the ones the admin gave them. */
export const GRANTABLE_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key as string);

export interface StaffPermissions { actions: string[]; grantable: string[] }

export function parseStaffPermissions(raw: string | null | undefined): StaffPermissions {
  try {
    const p = JSON.parse(raw ?? '{}');
    return {
      actions: Array.isArray(p.actions) ? p.actions.filter((a: unknown) => typeof a === 'string' && ACTION_KEYS.includes(a)) : [],
      grantable: Array.isArray(p.grantable) ? p.grantable.filter((a: unknown) => typeof a === 'string' && GRANTABLE_KEYS.includes(a)) : [],
    };
  } catch { return { actions: [], grantable: [] }; }
}

/** Drop unknown keys and duplicates, so what is stored is always a clean subset of the catalogs. */
export const cleanActions = (a: string[]) => [...new Set(a)].filter((k) => ACTION_KEYS.includes(k));
export const cleanGrantable = (a: string[]) => [...new Set(a)].filter((k) => GRANTABLE_KEYS.includes(k));

/** A row joined with its role (if any): the role's powers win over the person's own set. */
export function effectivePermissions(row: { staff_permissions?: string | null; role_actions?: string | null; role_grantable?: string | null }): StaffPermissions {
  if (row.role_actions != null) return parseStaffPermissions(JSON.stringify({ actions: JSON.parse(row.role_actions), grantable: JSON.parse(row.role_grantable ?? '[]') }));
  return parseStaffPermissions(row.staff_permissions);
}

export async function loadStaffPermissions(userId: number): Promise<StaffPermissions> {
  const u = await q1<any>(pool, `SELECT u.staff_permissions, r.actions role_actions, r.grantable role_grantable
    FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.role = 'company_employee'`, [userId]);
  return u ? effectivePermissions(u) : { actions: [], grantable: [] };
}

/** Read from the database on every request, so the admin switching something off takes effect immediately. */
export const requireStaffAction = (action: StaffAction) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const p = await loadStaffPermissions(req.auth!.userId);
    if (!p.actions.includes(action)) return next(forbidden('The admin has not given you this permission'));
    next();
  } catch (e) { next(e); }
};
