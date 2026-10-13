import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { notifyUsers } from '../../services/notify';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { storefrontProducts } from '../catalog/catalog.routes';
import { nearbyDistributors, storeAccess } from './access';
import { DEFAULT_PERMISSIONS } from '../distributors/subscription';
import { allowedCategoryIds, audienceClause, categoryClause } from '../catalog/scope';
import { toCsv } from '../../utils/tabular';
import { parseSocial } from '../distributors/social';

export const retailerRouter = Router();
retailerRouter.use(authenticate, requireRole('retailer'));

const ACTIVE = 'dp.subscription_ends_at > UTC_TIMESTAMP()';

const PREVIEW = 20;

/**
 * The retailer's home: the distributor who brought them in (pinned) first, with a preview of its products; then every other
 * distributor they are connected to; then distributors that sell in their pincode. retailer_id always comes from the token.
 */
retailerRouter.get('/stores', asyncHandler(async (req, res) => {
  const retailerId = req.auth!.userId;
  const profile = await q1<any>(pool, 'SELECT pincode FROM retailer_profiles WHERE user_id = ?', [retailerId]);
  const pincode = z.string().regex(/^\d{6}$/).default(profile.pincode).parse(req.query.pincode);

  const linked = await q<any>(pool, `
    SELECT dp.user_id id, dp.business_name, dp.city, dp.permissions, dp.social_links, rdr.is_primary, rdr.requested_by, rdr.balance_due_paise, rdr.credit_limit_paise, rdr.credit_days
    FROM retailer_distributor_relations rdr JOIN distributor_profiles dp ON dp.user_id = rdr.distributor_id
    WHERE rdr.retailer_id = ? AND rdr.status = 'active' AND ${ACTIVE} ORDER BY rdr.is_primary DESC, rdr.id`, [retailerId]);

  const card = (r: any) => {
    const perms = { ...DEFAULT_PERMISSIONS, ...JSON.parse(r.permissions) };
    return {
      id: r.id, business_name: r.business_name, city: r.city ?? null, is_pinned: !!r.is_primary, balance_due_paise: Number(r.balance_due_paise),
      credit_limit: r.credit_limit_paise == null ? null : fromPaise(Number(r.credit_limit_paise)), credit_days: r.credit_days,
      in_hierarchy: !!r.is_primary || r.requested_by === 'distributor', accepts_online_payment: !!perms.online_payments, accepts_cod: !!perms.cod_enabled, chat_enabled: !!perms.chat_enabled,
      social_links: parseSocial(r.social_links),
    };
  };
  const primaryRow = linked.find((r) => r.is_primary);
  const primary = primaryRow ? { ...card(primaryRow), ...(await storefrontProducts(primaryRow.id, { limit: PREVIEW, retailerId })), product_count: await countProducts(primaryRow.id, retailerId) } : null;
  const others = linked.filter((r) => !r.is_primary).map(card);
  const nearby = (await nearbyDistributors(pool, retailerId, pincode)).map((o) => ({ id: o.id, business_name: o.business_name, city: o.city ?? null, is_pinned: false, linked: false, commission_applicable: true }));

  res.json({
    primary_distributor: primary,
    // distributors this retailer is already connected to (besides the pinned one)
    linked_distributors: others,
    // sells in the retailer's pincode but not connected yet; orders to these carry platform commission
    nearby_distributors: nearby,
    // older clients: both lists together
    other_distributors: [...others.map((o) => ({ ...o, linked: true, commission_applicable: !o.in_hierarchy })), ...nearby],
  });
}));

const countProducts = async (distributorId: number, retailerId: number) => {
  const scope = categoryClause(await allowedCategoryIds(pool, retailerId, distributorId));
  const own = audienceClause(retailerId);
  return Number((await q1<any>(pool, `SELECT COUNT(*) n FROM products WHERE distributor_id = ? AND deleted_at IS NULL AND is_active = 1 AND review_status = 'approved'${scope.sql}${own.sql}`, [distributorId, ...scope.args, ...own.args]))!.n);
};

/** A store's profile page. Only for stores this retailer may see. */
retailerRouter.get('/stores/:distributorId', asyncHandler(async (req, res) => {
  const id = idParam(req, 'distributorId');
  const access = await storeAccess(pool, req.auth!.userId, id);
  if (!access) throw notFound('Store');
  const d = (await q1<any>(pool, 'SELECT user_id id, business_name, city, address, gst_no, permissions, social_links FROM distributor_profiles WHERE user_id = ?', [id]))!;
  const rel = await q1<any>(pool, "SELECT is_primary, requested_by, balance_due_paise, credit_limit_paise, credit_days FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active'", [req.auth!.userId, id]);
  const perms = { ...DEFAULT_PERMISSIONS, ...JSON.parse(d.permissions) };
  const offers = (await q1<any>(pool, "SELECT COUNT(*) n FROM announcements WHERE distributor_id = ? AND (valid_until IS NULL OR valid_until >= UTC_DATE()) AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)", [id]))!.n;
  res.json({
    id: d.id, business_name: d.business_name, city: d.city ?? null, address: access === 'linked' ? d.address ?? null : null, gst_no: access === 'linked' ? d.gst_no : null,
    access, is_pinned: !!rel?.is_primary, in_hierarchy: !!rel && (!!rel.is_primary || rel.requested_by === 'distributor'),
    commission_applicable: !(rel && (rel.is_primary || rel.requested_by === 'distributor')),
    balance_due_paise: rel ? Number(rel.balance_due_paise) : 0, credit_limit: rel?.credit_limit_paise == null ? null : fromPaise(Number(rel.credit_limit_paise)), credit_days: rel?.credit_days ?? 0,
    product_count: await countProducts(id, req.auth!.userId), offers: Number(offers), accepts_online_payment: !!perms.online_payments, accepts_cod: !!perms.cod_enabled, social_links: parseSocial(d.social_links), chat_enabled: !!perms.chat_enabled && access === 'linked',
  });
}));

/**
 * The retailer's own price list as a spreadsheet: exactly the products they may see, at the prices THEY pay (standard, break,
 * contract). It is built for the signed-in retailer from the same filters as the storefront, so it can never contain another
 * retailer's products or prices, and is never cached.
 */
retailerRouter.get('/stores/:distributorId/price-list.csv', asyncHandler(async (req, res) => {
  const id = idParam(req, 'distributorId');
  if (!(await storeAccess(pool, req.auth!.userId, id))) throw notFound('Store');
  const { products } = await storefrontProducts(id, { retailerId: req.auth!.userId, limit: 5000 });
  const name = (await q1<any>(pool, 'SELECT business_name FROM distributor_profiles WHERE user_id = ?', [id]))!.business_name;
  const rows = products.map((p: any) => ({
    name: p.display_name ?? p.name, sku: p.sku ?? '', category: p.category ?? '', unit: p.unit, price: p.price, gst: p.gst_rate_bps / 100, moq: p.min_order_qty,
    breaks: (p.tiers ?? []).map((t: any) => `${t.min_qty}+ at ${t.price}`).join('; '), available: p.available_qty ?? p.stock_qty, note: p.price_note ?? '',
  }));
  await audit(req.auth!.userId, 'retailer.price_download', 'user', id, { products: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="price-list-${String(name).replace(/[^\w]+/g, '-').slice(0, 40)}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(toCsv([
    { key: 'name', header: 'Product' }, { key: 'sku', header: 'SKU' }, { key: 'category', header: 'Category' }, { key: 'unit', header: 'Unit' },
    { key: 'price', header: 'Your price (INR, excl. GST)', type: 'number' }, { key: 'gst', header: 'GST %', type: 'number' }, { key: 'moq', header: 'Minimum order', type: 'number' },
    { key: 'breaks', header: 'Quantity prices' }, { key: 'available', header: 'Available', type: 'number' }, { key: 'note', header: 'Note' },
  ], rows));
}));

// Distributors this retailer has an account with, plus running balance (for the Khata tab).
retailerRouter.get('/distributors', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `
    SELECT dp.user_id id, dp.business_name, rdr.is_primary, rdr.balance_due_paise
    FROM retailer_distributor_relations rdr JOIN distributor_profiles dp ON dp.user_id = rdr.distributor_id
    WHERE rdr.retailer_id = ? AND rdr.status = 'active' ORDER BY rdr.is_primary DESC, dp.business_name`, [req.auth!.userId]);
  res.json({ distributors: rows.map((r) => ({ id: r.id, business_name: r.business_name, is_primary: !!r.is_primary, balance_due: fromPaise(Number(r.balance_due_paise)) })) });
}));

retailerRouter.get('/stores/:distributorId/products', asyncHandler(async (req, res) => {
  const id = idParam(req, 'distributorId');
  // A distributor's catalog is not public: only connected retailers, or retailers in a pincode it sells to, may see it.
  if (!(await storeAccess(pool, req.auth!.userId, id))) throw notFound('Store');
  const qs = z.object({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json(await storefrontProducts(id, { ...qs, retailerId: req.auth!.userId }));
}));

// Pin a distributor as primary (exclusive).
retailerRouter.put('/primary', asyncHandler(async (req, res) => {
  const { distributor_id } = z.object({ distributor_id: z.number().int().positive() }).parse(req.body);
  const retailerId = req.auth!.userId;
  if (!(await storeAccess(pool, retailerId, distributor_id))) throw new AppError(404, 'NOT_FOUND', 'Distributor not found or inactive');
  await withTx(async (c) => {
    await exec(c, 'INSERT IGNORE INTO retailer_distributor_relations (retailer_id, distributor_id) VALUES (?,?)', [retailerId, distributor_id]);
    // choosing a distributor yourself is consent: it also activates a request they had sent
    await exec(c, "UPDATE retailer_distributor_relations SET status = 'active' WHERE retailer_id = ? AND distributor_id = ?", [retailerId, distributor_id]);
    await exec(c, 'UPDATE retailer_distributor_relations SET is_primary = (distributor_id = ?) WHERE retailer_id = ?', [distributor_id, retailerId]);
  });
  res.json({ primary_distributor_id: distributor_id });
}));

// Suppliers who asked to link with this retailer. Nothing is active until the retailer accepts.
retailerRouter.get('/link-requests', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `
    SELECT dp.user_id id, dp.business_name, dp.gst_no FROM retailer_distributor_relations rdr
    JOIN distributor_profiles dp ON dp.user_id = rdr.distributor_id
    WHERE rdr.retailer_id = ? AND rdr.status = 'pending' AND rdr.requested_by = 'distributor' ORDER BY rdr.id DESC`, [req.auth!.userId]);
  res.json({ requests: rows });
}));

retailerRouter.post('/link-requests/:distributorId/accept', asyncHandler(async (req, res) => {
  const distributorId = idParam(req, 'distributorId');
  const retailerId = req.auth!.userId;
  await withTx(async (c) => {
    const rel = await q1<any>(c, "SELECT id FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'pending' FOR UPDATE", [retailerId, distributorId]);
    if (!rel) throw notFound('Request');
    const hasPrimary = await q1(c, "SELECT id FROM retailer_distributor_relations WHERE retailer_id = ? AND is_primary = 1 AND status = 'active'", [retailerId]);
    await exec(c, "UPDATE retailer_distributor_relations SET status = 'active', is_primary = ? WHERE id = ?", [hasPrimary ? 0 : 1, rel.id]);
  });
  await audit(retailerId, 'relation.accept', 'user', distributorId);
  notifyUsers([distributorId], 'Retailer accepted', 'A retailer accepted your request. You can now take their orders.', { type: 'link' });
  res.json({ status: 'active' });
}));

retailerRouter.post('/link-requests/:distributorId/decline', asyncHandler(async (req, res) => {
  const r = await exec(pool, "DELETE FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'pending'", [req.auth!.userId, idParam(req, 'distributorId')]);
  if (!r.affectedRows) throw notFound('Request');
  res.status(204).end();
}));
