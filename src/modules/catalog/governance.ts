import { Conn, exec, pool, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';
import { fromPaise } from '../../utils/money';
import { loadTiers } from './stock';

/**
 * Catalogue governance in one place: managed categories and brands, the product review step, and version history.
 * Every product write path (create, edit, duplicate, bulk action, import) finishes by calling syncProduct inside its own
 * transaction, so the rules below cannot be forgotten by one path.
 */

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------
export async function approvalRequired(c: Conn = pool): Promise<boolean> {
  const r = await q1<{ value: string }>(c, "SELECT value FROM platform_settings WHERE name = 'product_approval_required'");
  return r?.value === '1';
}
export async function setApprovalRequired(on: boolean) {
  await exec(pool, "INSERT INTO platform_settings (name, value) VALUES ('product_approval_required', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [on ? '1' : '0']);
}

// ---------------------------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------------------------
export type TaxKind = 'category' | 'brand';
const TABLE: Record<TaxKind, string> = { category: 'categories', brand: 'brands' };
export const nameKey = (s: string) => s.trim().toLowerCase().slice(0, 80);

/** Follow "merged into" links to the entry that is actually in use (bounded, so a bad loop cannot hang a request). */
async function follow(c: Conn, kind: TaxKind, row: any): Promise<any> {
  let cur = row;
  for (let i = 0; i < 5 && cur?.status === 'retired' && cur.merged_into_id; i++) {
    cur = (await q1<any>(c, `SELECT * FROM ${TABLE[kind]} WHERE id = ?`, [cur.merged_into_id])) ?? cur;
  }
  return cur;
}

/**
 * The managed entry for a typed name. Matching ignores case and spacing. A name nobody has used before is created as
 * 'pending' so it works immediately but shows up for the admin to approve, rename or merge.
 */
export async function resolveName(c: Conn, kind: TaxKind, raw: string, actorId: number | null): Promise<{ id: number; name: string }> {
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  const key = nameKey(name);
  const t = TABLE[kind];
  const find = () => q1<any>(c, `SELECT * FROM ${t} WHERE name_key = ? ORDER BY ${kind === 'category' ? 'parent_key, ' : ''}id LIMIT 1`, [key]);
  let row = await find();
  if (row) {
    row = await follow(c, kind, row);
    if (row.status === 'retired') {                        // retired without a merge target: the name is in use again
      await exec(c, `UPDATE ${t} SET status = 'pending' WHERE id = ?`, [row.id]);
    }
    return { id: row.id, name: row.name };
  }
  try {
    const r = await exec(c, `INSERT INTO ${t} (name, name_key, status, created_by) VALUES (?,?, 'pending', ?)`, [name, key, actorId]);
    return { id: r.insertId, name };
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') { row = await find(); if (row) return { id: row.id, name: row.name }; }
    throw e;
  }
}

/** Translate category_id / brand_id in a request into the names the product columns store. */
export async function idsToNames(body: { category?: string | null; brand?: string | null; category_id?: number | null; brand_id?: number | null }, c: Conn = pool) {
  for (const kind of ['category', 'brand'] as const) {
    const idKey = `${kind}_id` as const;
    const id = body[idKey];
    if (id === undefined) continue;
    delete body[idKey];
    if (id === null) { body[kind] = null; continue; }
    const row = await q1<any>(c, `SELECT * FROM ${TABLE[kind]} WHERE id = ? AND status <> 'retired'`, [id]);
    if (!row) throw new AppError(400, `UNKNOWN_${kind.toUpperCase()}`, `That ${kind} does not exist or is no longer in use`);
    body[kind] = row.name;
  }
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------
const TRACKED = ['name', 'sku', 'barcode', 'variant_group', 'variant_label', 'category', 'brand', 'unit', 'description', 'hsn', 'gst_rate_bps', 'min_order_qty', 'low_stock_threshold', 'is_active', 'review_status'] as const;

async function snapshotOf(c: Conn, p: any) {
  const tiers = (await loadTiers(c, [p.id])).get(p.id) ?? [];
  const snap: Record<string, unknown> = Object.fromEntries(TRACKED.map((k) => [k, k === 'is_active' ? !!p[k] : p[k] ?? null]));
  snap.price = fromPaise(Number(p.price_paise));
  snap.mrp = p.mrp_paise == null ? null : fromPaise(Number(p.mrp_paise));
  snap.cost = p.cost_paise == null ? null : fromPaise(Number(p.cost_paise));
  snap.tiers = tiers.map((t) => ({ min_qty: t.min_qty, price: fromPaise(t.price_paise) }));
  return snap;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Write a version if anything tracked changed (or this is the first one). Returns the new version number, or null. */
export async function recordVersion(c: Conn, productId: number, actorId: number | null, changeType: string): Promise<number | null> {
  const p = await q1<any>(c, 'SELECT * FROM products WHERE id = ?', [productId]);
  if (!p) return null;
  const snap = await snapshotOf(c, p);
  const last = await q1<any>(c, 'SELECT version_no, snapshot FROM product_versions WHERE product_id = ? ORDER BY version_no DESC LIMIT 1', [productId]);
  const prev = last ? JSON.parse(last.snapshot) : null;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (prev) {
    for (const k of Object.keys(snap)) if (!same(prev[k], snap[k])) changes[k] = { from: prev[k] ?? null, to: snap[k] };
    if (!Object.keys(changes).length) return null;
  }
  const no = (last?.version_no ?? 0) + 1;
  await exec(c, 'INSERT INTO product_versions (product_id, version_no, change_type, actor_id, snapshot, changes) VALUES (?,?,?,?,?,?)', [productId, no, changeType, actorId, JSON.stringify(snap), JSON.stringify(changes)]);
  return no;
}

export async function listVersions(c: Conn, productId: number) {
  const rows = await q<any>(c, `SELECT v.version_no, v.change_type, v.actor_id, u.name actor_name, v.snapshot, v.changes, v.created_at
    FROM product_versions v LEFT JOIN users u ON u.id = v.actor_id WHERE v.product_id = ? ORDER BY v.version_no DESC LIMIT 100`, [productId]);
  return rows.map((r) => ({
    version: r.version_no, change_type: r.change_type, by: r.actor_name ?? null, at: r.created_at,
    changes: JSON.parse(r.changes), snapshot: JSON.parse(r.snapshot),
  }));
}

// ---------------------------------------------------------------------------------------------
// The hook every product write path calls
// ---------------------------------------------------------------------------------------------
const CREATING = new Set(['create', 'duplicate', 'import_create']);

/**
 * After a product row was inserted or changed: attach it to the managed category and brand, apply the review rule,
 * and record a version. Runs inside the caller's transaction.
 */
export async function syncProduct(c: Conn, productId: number, actorId: number | null, changeType: string) {
  const p = await q1<any>(c, 'SELECT * FROM products WHERE id = ?', [productId]);
  if (!p) return;

  // 1. managed category and brand (the text columns stay, as the canonical spelling, for everything that reads them)
  const cat = p.category && p.category.trim() ? await resolveName(c, 'category', p.category, actorId) : null;
  const brand = p.brand && p.brand.trim() ? await resolveName(c, 'brand', p.brand, actorId) : null;
  if ((cat?.id ?? null) !== (p.category_id ?? null) || (brand?.id ?? null) !== (p.brand_id ?? null) || (cat?.name ?? null) !== (p.category ?? null) || (brand?.name ?? null) !== (p.brand ?? null)) {
    await exec(c, 'UPDATE products SET category = ?, category_id = ?, brand = ?, brand_id = ? WHERE id = ?', [cat?.name ?? null, cat?.id ?? null, brand?.name ?? null, brand?.id ?? null, productId]);
  }

  // 2. review: new products wait when approval is on; fixing a rejected product sends it back for another look
  let status: string = p.review_status;
  if (CREATING.has(changeType)) { if (await approvalRequired(c)) status = 'pending'; }
  else if (status === 'rejected' && (changeType === 'update' || changeType === 'import_update')) status = 'pending';
  if (status !== p.review_status) {
    await exec(c, "UPDATE products SET review_status = ?, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?", [status, productId]);
  }

  // 3. version history
  await recordVersion(c, productId, actorId, changeType);
}

/** The reviewer's decision. A rejection needs a reason, so the distributor knows what to fix. */
export async function reviewProduct(c: Conn, productId: number, reviewerId: number, action: 'approve' | 'reject', note?: string | null) {
  const p = await q1<any>(c, 'SELECT * FROM products WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [productId]);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  if (p.review_status !== 'pending') throw new AppError(409, 'NOT_PENDING', `This product is already ${p.review_status}`);
  if (action === 'reject' && !note?.trim()) throw new AppError(400, 'NOTE_REQUIRED', 'Say what needs to change, so the distributor can fix it');
  const status = action === 'approve' ? 'approved' : 'rejected';
  await exec(c, 'UPDATE products SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?', [status, action === 'reject' ? note!.trim().slice(0, 300) : null, reviewerId, productId]);
  // an approved category / brand that was only "pending" is accepted along with the product
  if (action === 'approve') {
    if (p.category_id) await exec(c, "UPDATE categories SET status = 'active' WHERE id = ? AND status = 'pending'", [p.category_id]);
    if (p.brand_id) await exec(c, "UPDATE brands SET status = 'active' WHERE id = ? AND status = 'pending'", [p.brand_id]);
  }
  await recordVersion(c, productId, reviewerId, action === 'approve' ? 'review_approved' : 'review_rejected');
  return { distributor_id: p.distributor_id as number, name: p.name as string, status };
}
