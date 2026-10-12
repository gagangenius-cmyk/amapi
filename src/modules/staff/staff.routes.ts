import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q1 } from '../../db/pool';
import { authenticate, invalidateUser, requireRole, requireTwoFactor } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { loadDistributor, PERMISSION_CATALOG } from '../distributors/subscription';
import { loadStaffPermissions, requireStaffAction, STAFF_ACTIONS } from './permissions';
import { commissionReport, createDistributorAccount, distributorBody, grantCatalog, listDistributors, resolvePermissions } from './staff.service';

/** The company employee's own area: create and look after distributors, within what the admin allowed. */
export const staffRouter = Router();
staffRouter.use(authenticate, requireRole('company_employee'), requireTwoFactor);

staffRouter.get('/me', asyncHandler(async (req, res) => {
  const p = await loadStaffPermissions(req.auth!.userId);
  res.json({
    actions: p.actions, grantable: p.grantable,
    action_catalog: STAFF_ACTIONS.filter((a) => p.actions.includes(a.key)),
    grant_catalog: grantCatalog(p.grantable),
  });
}));

staffRouter.get('/distributors', asyncHandler(async (req, res) => {
  const me = req.auth!.userId;
  const p = await loadStaffPermissions(me);
  const all = p.actions.includes('view_all_distributors');
  const distributors = await listDistributors(all ? '1=1' : 'u.created_by = ?', all ? [] : [me]);
  res.json({
    can_create: p.actions.includes('create_distributors'), can_manage: p.actions.includes('manage_distributors'),
    grant_catalog: grantCatalog(p.grantable), permission_labels: PERMISSION_CATALOG,
    // `mine` tells the app which ones this person may change
    distributors: distributors.map((d) => ({ ...d, mine: d.created_by === me })),
  });
}));

staffRouter.post('/distributors', requireStaffAction('create_distributors'), asyncHandler(async (req, res) => {
  const b = distributorBody.parse(req.body);
  const me = req.auth!.userId;
  const p = await loadStaffPermissions(me);
  const out = await createDistributorAccount(b, me, p.grantable);
  await audit(me, 'staff.distributor_create', 'user', out.id, { phone: b.phone, permissions: out.permissions });
  res.status(201).json({ id: out.id, phone: b.phone, business_name: b.business_name, permissions: out.permissions });
}));

// Change one of the distributors this person created: feature switches (only the ones granted to them), extra days, on/off.
staffRouter.put('/distributors/:id', requireStaffAction('manage_distributors'), asyncHandler(async (req, res) => {
  const b = z.object({
    permissions: z.record(z.string(), z.boolean()).optional(),
    extend_days: z.number().int().min(1).max(365).optional(),
    is_active: z.boolean().optional(),
  }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const me = req.auth!.userId; const id = idParam(req);
  const target = await q1<any>(pool, "SELECT id FROM users WHERE id = ? AND role = 'distributor' AND created_by = ?", [id, me]);
  if (!target) throw notFound('Distributor');   // someone else's distributor looks like a missing one
  const p = await loadStaffPermissions(me);
  const d = await loadDistributor(pool, id);
  const perms = resolvePermissions(b.permissions, p.grantable, d.permissions);
  await exec(pool, `UPDATE distributor_profiles SET permissions = ?,
    subscription_ends_at = IF(? IS NULL, subscription_ends_at, DATE_ADD(GREATEST(subscription_ends_at, UTC_TIMESTAMP()), INTERVAL ? DAY)),
    expiry_warned_at = IF(? IS NULL, expiry_warned_at, NULL) WHERE user_id = ?`, [JSON.stringify(perms), b.extend_days ?? null, b.extend_days ?? 0, b.extend_days ?? null, id]);
  if (b.is_active !== undefined) {
    await exec(pool, 'UPDATE users SET is_active = ? WHERE id = ?', [b.is_active ? 1 : 0, id]);
    if (!b.is_active) await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    invalidateUser(id);
  }
  await audit(me, 'staff.distributor_update', 'user', id, b);
  res.json((await listDistributors('u.id = ?', [id]))[0]);
}));

staffRouter.get('/commissions', requireStaffAction('view_commissions'), asyncHandler(async (_req, res) => {
  res.json({ commissions: await commissionReport() });
}));
