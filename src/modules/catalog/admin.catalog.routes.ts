import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { fromPaise } from '../../utils/money';
import { approvalRequired, listVersions, nameKey, reviewProduct, setApprovalRequired, TaxKind } from './governance';
import { reconcile } from '../inventory/inventory.service';

/**
 * Admin side of catalogue governance. Mounted inside the admin router, so sign-in, the admin role and two-factor are
 * already enforced.
 */
export const adminCatalogRouter = Router();

const TABLE: Record<TaxKind, string> = { category: 'categories', brand: 'brands' };
const COLUMN: Record<TaxKind, string> = { category: 'category_id', brand: 'brand_id' };

const nameField = z.string().trim().min(1).max(80).transform((s) => s.replace(/\s+/g, ' '));
const status = z.enum(['active', 'pending', 'retired']);

function taxonomyRoutes(kind: TaxKind, path: string) {
  const t = TABLE[kind]; const col = COLUMN[kind];

  adminCatalogRouter.get(`/${path}`, asyncHandler(async (req, res) => {
    const { status: st } = z.object({ status: status.optional() }).parse(req.query);
    const rows = await q<any>(pool, `SELECT x.*, (SELECT COUNT(*) FROM products p WHERE p.${col} = x.id AND p.deleted_at IS NULL) products
      FROM ${t} x ${st ? 'WHERE x.status = ?' : ''} ORDER BY (x.status = 'pending') DESC, x.name`, st ? [st] : []);
    res.json({ items: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, merged_into_id: r.merged_into_id, parent_id: r.parent_id ?? null, products: Number(r.products), created_at: r.created_at })) });
  }));

  adminCatalogRouter.post(`/${path}`, asyncHandler(async (req, res) => {
    const b = z.object({ name: nameField, ...(kind === 'category' ? { parent_id: z.number().int().positive().nullable().optional() } : {}) }).parse(req.body) as { name: string; parent_id?: number | null };
    if (kind === 'category' && b.parent_id && !(await q1(pool, "SELECT 1 FROM categories WHERE id = ? AND status <> 'retired'", [b.parent_id]))) throw new AppError(400, 'BAD_PARENT', 'Parent category not found');
    try {
      const r = kind === 'category'
        ? await exec(pool, "INSERT INTO categories (name, name_key, parent_id, parent_key, status, created_by) VALUES (?,?,?,?, 'active', ?)", [b.name, nameKey(b.name), b.parent_id ?? null, b.parent_id ?? 0, req.auth!.userId])
        : await exec(pool, "INSERT INTO brands (name, name_key, status, created_by) VALUES (?,?, 'active', ?)", [b.name, nameKey(b.name), req.auth!.userId]);
      await audit(req.auth!.userId, `catalog.${kind}_create`, kind, r.insertId, { name: b.name });
      res.status(201).json({ id: r.insertId, name: b.name, status: 'active' });
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', `A ${kind} with this name already exists`);
      throw e;
    }
  }));

  // Rename, approve (pending -> active) or retire. Renaming also updates the spelling stored on every product that uses it.
  adminCatalogRouter.put(`/${path}/:id`, asyncHandler(async (req, res) => {
    const b = z.object({ name: nameField.optional(), status: status.optional() }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
    const id = idParam(req);
    const cur = await q1<any>(pool, `SELECT * FROM ${t} WHERE id = ?`, [id]);
    if (!cur) throw new AppError(404, 'NOT_FOUND', `${kind} not found`);
    if (cur.merged_into_id && b.status && b.status !== 'retired') throw new AppError(409, 'MERGED', 'This entry was merged into another one');
    try {
      await withTx(async (c) => {
        await exec(c, `UPDATE ${t} SET name = ?, name_key = ?, status = ? WHERE id = ?`, [b.name ?? cur.name, nameKey(b.name ?? cur.name), b.status ?? cur.status, id]);
        if (b.name && b.name !== cur.name) await exec(c, `UPDATE products SET ${kind} = ? WHERE ${col} = ?`, [b.name, id]);
      });
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', `A ${kind} with this name already exists. Merge them instead.`);
      throw e;
    }
    await audit(req.auth!.userId, `catalog.${kind}_update`, kind, id, b);
    res.json({ id, ...b });
  }));

  // Fold one entry into another: products move, the old name is retired and keeps pointing at its replacement.
  adminCatalogRouter.post(`/${path}/:id/merge`, asyncHandler(async (req, res) => {
    const { into_id } = z.object({ into_id: z.number().int().positive() }).parse(req.body);
    const id = idParam(req);
    if (id === into_id) throw new AppError(400, 'SAME', 'Choose a different target');
    const moved = await withTx(async (c) => {
      const from = await q1<any>(c, `SELECT * FROM ${t} WHERE id = ? FOR UPDATE`, [id]);
      const to = await q1<any>(c, `SELECT * FROM ${t} WHERE id = ? FOR UPDATE`, [into_id]);
      if (!from || !to) throw new AppError(404, 'NOT_FOUND', `${kind} not found`);
      if (to.status === 'retired') throw new AppError(409, 'TARGET_RETIRED', 'The target is retired. Merge into an active entry.');
      const r = await exec(c, `UPDATE products SET ${col} = ?, ${kind} = ? WHERE ${col} = ?`, [to.id, to.name, id]);
      if (kind === 'category') await exec(c, 'UPDATE categories SET parent_id = ?, parent_key = ? WHERE parent_id = ?', [to.id, to.id, id]);
      await exec(c, `UPDATE ${t} SET status = 'retired', merged_into_id = ? WHERE id = ?`, [to.id, id]);
      if (to.status === 'pending') await exec(c, `UPDATE ${t} SET status = 'active' WHERE id = ?`, [to.id]);
      return r.affectedRows;
    });
    await audit(req.auth!.userId, `catalog.${kind}_merge`, kind, id, { into_id, products: moved });
    res.json({ merged: true, products_moved: moved });
  }));
}
taxonomyRoutes('category', 'categories');
taxonomyRoutes('brand', 'brands');

// ---------------------------------------------------------------------------------------------
// Product review
// ---------------------------------------------------------------------------------------------
adminCatalogRouter.get('/catalog-settings', asyncHandler(async (_req, res) => {
  const pending = await q1<any>(pool, "SELECT COUNT(*) n FROM products WHERE review_status = 'pending' AND deleted_at IS NULL");
  res.json({ product_approval_required: await approvalRequired(), pending_review: Number(pending!.n) });
}));

adminCatalogRouter.put('/catalog-settings', asyncHandler(async (req, res) => {
  const b = z.object({ product_approval_required: z.boolean() }).parse(req.body);
  await setApprovalRequired(b.product_approval_required);
  await audit(req.auth!.userId, 'catalog.approval_setting', 'settings', null, b);
  res.json({ product_approval_required: b.product_approval_required });
}));

adminCatalogRouter.get('/product-review', asyncHandler(async (req, res) => {
  const qs = z.object({ status: z.enum(['pending', 'rejected', 'approved']).default('pending'), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  const rows = await q<any>(pool, `SELECT p.id, p.name, p.category, p.brand, p.unit, p.price_paise, p.gst_rate_bps, p.sku, p.review_status, p.review_note, p.reviewed_at, p.created_at,
      p.distributor_id, dp.business_name distributor, p.category_id, p.brand_id, c.status category_status, b.status brand_status
    FROM products p JOIN distributor_profiles dp ON dp.user_id = p.distributor_id
    LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.review_status = ? AND p.deleted_at IS NULL ORDER BY p.id LIMIT ?`, [qs.status, qs.limit]);
  res.json({ products: rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, brand: r.brand, unit: r.unit, sku: r.sku, price: fromPaise(Number(r.price_paise)), gst_rate_bps: r.gst_rate_bps,
    distributor_id: r.distributor_id, distributor: r.distributor, review_status: r.review_status, review_note: r.review_note, created_at: r.created_at,
    new_category: r.category_status === 'pending', new_brand: r.brand_status === 'pending',
  })) });
}));

adminCatalogRouter.post('/products/:id/review', asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['approve', 'reject']), note: z.string().trim().max(300).nullable().optional() }).parse(req.body);
  const id = idParam(req);
  const out = await withTx((c) => reviewProduct(c, id, req.auth!.userId, b.action, b.note));
  await audit(req.auth!.userId, `catalog.product_${b.action}`, 'product', id, { note: b.note ?? null });
  notifyUsers([out.distributor_id], b.action === 'approve' ? 'Product approved' : 'Product needs changes',
    b.action === 'approve' ? `${out.name} is now visible to retailers.` : `${out.name}: ${b.note}`, { type: 'catalog', id });
  res.json({ id, review_status: out.status });
}));

adminCatalogRouter.get('/products/:id/versions', asyncHandler(async (req, res) => {
  const id = idParam(req);
  if (!(await q1(pool, 'SELECT 1 FROM products WHERE id = ?', [id]))) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  res.json({ versions: await listVersions(pool, id) });
}));

// Platform-wide stock integrity: every product whose stock figure, warehouse balances, ledger and batches disagree.
adminCatalogRouter.get('/inventory/reconciliation', asyncHandler(async (_req, res) => {
  const r = await reconcile();
  res.json({ checked: r.checked, clean: r.clean, issues: r.issues.slice(0, 200), issue_count: r.issues.length });
}));
