import { Request, Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, invalidateUser, requireRole, requireTwoFactor } from '../../middleware/auth';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { asyncHandler, forbidden, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { reviewProduct } from '../catalog/governance';
import { categoryNames, distributorCategoryIds, validateCategoryChoice } from '../catalog/scope';
import { loadDistributor, PERMISSION_CATALOG } from '../distributors/subscription';
import { staffOnboardingRouter } from '../onboarding/onboarding.routes';
import { makeReportsRouter } from '../reports/admin.reports.routes';
import { loadStaffPermissions, requireStaffAction, STAFF_ACTIONS } from './permissions';
import { commissionReport, grantCatalog, listDistributors, resolvePermissions } from './staff.service';

/** The company employee's own area: onboard and look after distributors, within what the admin allowed. */
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

/** The distributors mapped to this employee: the ones they onboarded (or the admin handed to them). */
export const mappedDistributorIds = async (employeeId: number) =>
  (await q<{ id: number }>(pool, "SELECT id FROM users WHERE role = 'distributor' AND created_by = ?", [employeeId])).map((r) => r.id);

staffRouter.get('/distributors', asyncHandler(async (req, res) => {
  const me = req.auth!.userId;
  const p = await loadStaffPermissions(me);
  const all = p.actions.includes('view_all_distributors');
  const distributors = await listDistributors(all ? '1=1' : 'u.created_by = ?', all ? [] : [me]);
  const cats = distributors.length ? await q<any>(pool, 'SELECT dc.distributor_id, c.id, c.name FROM distributor_categories dc JOIN categories c ON c.id = dc.category_id WHERE dc.distributor_id IN (?)', [distributors.map((d) => d.id)]) : [];
  res.json({
    can_create: p.actions.includes('create_distributors'), can_manage: p.actions.includes('manage_distributors'),
    grant_catalog: grantCatalog(p.grantable), permission_labels: PERMISSION_CATALOG,
    // `mine` tells the app which ones this person may change
    distributors: distributors.map((d) => ({ ...d, mine: d.created_by === me, categories: cats.filter((c) => c.distributor_id === d.id).map((c) => ({ id: c.id, name: c.name })) })),
  });
}));

// Distributors are onboarded through a paid request: the account appears when the subscription fee has arrived.
staffRouter.use('/onboarding', staffOnboardingRouter);

// Change one of the distributors mapped to this person: feature switches (only the ones granted to them), categories, extra days, on/off.
staffRouter.put('/distributors/:id', requireStaffAction('manage_distributors'), asyncHandler(async (req, res) => {
  const b = z.object({
    permissions: z.record(z.string(), z.boolean()).optional(),
    category_ids: z.array(z.number().int().positive()).min(1).max(30).optional(),
    review_required: z.boolean().optional(),
    extend_days: z.number().int().min(1).max(365).optional(),
    is_active: z.boolean().optional(),
  }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const me = req.auth!.userId; const id = idParam(req);
  const target = await q1<any>(pool, "SELECT id FROM users WHERE id = ? AND role = 'distributor' AND created_by = ?", [id, me]);
  if (!target) throw notFound('Distributor');   // someone else's distributor looks like a missing one
  const p = await loadStaffPermissions(me);
  if (b.review_required !== undefined && !p.actions.includes('review_products')) throw forbidden('You do not have the product review power');
  const d = await loadDistributor(pool, id);
  const perms = resolvePermissions(b.permissions, p.grantable, d.permissions);
  const cats = b.category_ids ? await validateCategoryChoice(pool, b.category_ids) : null;
  await withTx(async (c) => {
    await exec(c, `UPDATE distributor_profiles SET permissions = ?, review_required = COALESCE(?, review_required),
      subscription_ends_at = IF(? IS NULL, subscription_ends_at, DATE_ADD(GREATEST(subscription_ends_at, UTC_TIMESTAMP()), INTERVAL ? DAY)),
      expiry_warned_at = IF(? IS NULL, expiry_warned_at, NULL) WHERE user_id = ?`,
      [JSON.stringify(perms), b.review_required === undefined ? null : b.review_required ? 1 : 0, b.extend_days ?? null, b.extend_days ?? 0, b.extend_days ?? null, id]);
    if (cats) {
      await exec(c, 'DELETE FROM distributor_categories WHERE distributor_id = ?', [id]);
      await exec(c, 'INSERT INTO distributor_categories (distributor_id, category_id) VALUES ?', [cats.map((x) => [id, x])]);
    }
  });
  if (b.is_active !== undefined) {
    await exec(pool, 'UPDATE users SET is_active = ? WHERE id = ?', [b.is_active ? 1 : 0, id]);
    if (!b.is_active) await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    invalidateUser(id);
  }
  await audit(me, 'staff.distributor_update', 'user', id, b);
  res.json({ ...(await listDistributors('u.id = ?', [id]))[0], categories: await categoryNames(pool, await distributorCategoryIds(pool, id)) });
}));

staffRouter.get('/commissions', requireStaffAction('view_commissions'), asyncHandler(async (req, res) => {
  const ids = await mappedDistributorIds(req.auth!.userId);
  const all = await commissionReport();
  res.json({ commissions: all.filter((c) => ids.includes(c.distributor_id)) });
}));

// ---------------------------------------------------------------------------------------------
// Product review: products of the distributors this person onboarded wait here until approved
// ---------------------------------------------------------------------------------------------
staffRouter.get('/product-review', requireStaffAction('review_products'), asyncHandler(async (req, res) => {
  const qs = z.object({ status: z.enum(['pending', 'rejected', 'approved']).default('pending'), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  const ids = await mappedDistributorIds(req.auth!.userId);
  if (!ids.length) return void res.json({ products: [] });
  const rows = await q<any>(pool, `SELECT p.id, p.name, p.category, p.brand, p.unit, p.price_paise, p.gst_rate_bps, p.sku, p.review_status, p.review_note, p.created_at,
      p.distributor_id, dp.business_name distributor, c.status category_status, b.status brand_status
    FROM products p JOIN distributor_profiles dp ON dp.user_id = p.distributor_id LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.review_status = ? AND p.deleted_at IS NULL AND p.distributor_id IN (?) ORDER BY p.id LIMIT ?`, [qs.status, ids, qs.limit]);
  res.json({ products: rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, brand: r.brand, unit: r.unit, sku: r.sku, price: fromPaise(Number(r.price_paise)), gst_rate_bps: r.gst_rate_bps,
    distributor_id: r.distributor_id, distributor: r.distributor, review_status: r.review_status, review_note: r.review_note, created_at: r.created_at,
    new_category: r.category_status === 'pending', new_brand: r.brand_status === 'pending',
  })) });
}));

staffRouter.post('/products/:id/review', requireStaffAction('review_products'), asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['approve', 'reject']), note: z.string().trim().max(300).nullable().optional() }).parse(req.body);
  const id = idParam(req); const me = req.auth!.userId;
  const owned = await q1<any>(pool, 'SELECT p.distributor_id FROM products p JOIN users u ON u.id = p.distributor_id WHERE p.id = ? AND u.created_by = ?', [id, me]);
  if (!owned) throw notFound('Product');         // a product of someone else's distributor looks like a missing one
  const out = await withTx((c) => reviewProduct(c, id, me, b.action, b.note));
  await audit(me, `catalog.product_${b.action}`, 'product', id, { note: b.note ?? null, by: 'company_employee' });
  notifyUsers([out.distributor_id], b.action === 'approve' ? 'Product approved' : 'Product needs changes',
    b.action === 'approve' ? `${out.name} is now visible to retailers.` : `${out.name}: ${b.note}`, { type: 'catalog', id });
  res.json({ id, review_status: out.status });
}));

// ---------------------------------------------------------------------------------------------
// Reports of the distributors mapped to this person (the same analytics and exports the admin has, limited to them)
// ---------------------------------------------------------------------------------------------
staffRouter.use('/team', requireStaffAction('view_team_reports'), makeReportsRouter(async (req: Request) => mappedDistributorIds(req.auth!.userId)));
