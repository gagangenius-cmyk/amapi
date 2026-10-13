import { Conn, q, q1 } from '../../db/pool';
import { AppError } from '../../utils/errors';

/**
 * CATEGORY SCOPE
 * A distributor is set up with the categories it deals in (Beverages, Hardware...). A retailer created for it is given the
 * categories that retailer may buy. A retailer only ever sees, prices and orders products of the categories it was given.
 *   - A retailer with no categories of its own (it signed up itself, or was made before this existed) is not restricted.
 *   - A category covers its sub-categories.
 *   - When the distributor has categories too, only the overlap counts, so narrowing the distributor narrows its retailers.
 *   - A product with no category is hidden from a restricted retailer.
 */
interface Cat { id: number; parent_id: number | null }

const allCategories = (c: Conn) => q<Cat>(c, "SELECT id, parent_id FROM categories WHERE status <> 'retired'");

/** The given ids and every category below them. */
export function withDescendants(all: Cat[], ids: number[]): Set<number> {
  const out = new Set<number>(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of all) if (c.parent_id !== null && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true; }
  }
  return out;
}

const idsOf = async (c: Conn, table: 'retailer_categories' | 'distributor_categories', col: string, id: number) =>
  (await q<{ category_id: number }>(c, `SELECT category_id FROM ${table} WHERE ${col} = ?`, [id])).map((r) => r.category_id);

/** null = no restriction; otherwise the category ids this retailer may see from this distributor (possibly none). */
export async function allowedCategoryIds(c: Conn, retailerId: number, distributorId: number): Promise<number[] | null> {
  const mine = await idsOf(c, 'retailer_categories', 'retailer_id', retailerId);
  if (!mine.length) return null;
  const all = await allCategories(c);
  const allowed = withDescendants(all, mine);
  const theirs = await idsOf(c, 'distributor_categories', 'distributor_id', distributorId);
  if (theirs.length) {
    const dist = withDescendants(all, theirs);
    for (const id of [...allowed]) if (!dist.has(id)) allowed.delete(id);
  }
  return [...allowed];
}

/** SQL for a product alias, and its arguments. `ids` null adds nothing. */
export function categoryClause(ids: number[] | null, column = 'category_id'): { sql: string; args: unknown[] } {
  if (ids === null) return { sql: '', args: [] };
  return ids.length ? { sql: ` AND ${column} IN (?)`, args: [ids] } : { sql: ' AND 1 = 0', args: [] };
}

/** Check a list of category ids chosen when creating or editing an account. */
export async function validateCategoryChoice(c: Conn, ids: number[], within?: number[]): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const all = await allCategories(c);
  const known = new Set(all.map((x) => x.id));
  const unknown = unique.filter((id) => !known.has(id));
  if (unknown.length) throw new AppError(400, 'BAD_CATEGORY', `Unknown or retired category: ${unknown.join(', ')}`);
  if (within?.length) {
    const ok = withDescendants(all, within);
    const outside = unique.filter((id) => !ok.has(id));
    if (outside.length) throw new AppError(400, 'CATEGORY_NOT_OFFERED', 'This distributor does not deal in one of those categories');
  }
  return unique;
}

export async function distributorCategoryIds(c: Conn, distributorId: number) { return idsOf(c, 'distributor_categories', 'distributor_id', distributorId); }
export async function retailerCategoryIds(c: Conn, retailerId: number) { return idsOf(c, 'retailer_categories', 'retailer_id', retailerId); }

export async function categoryNames(c: Conn, ids: number[]) {
  if (!ids.length) return [];
  return q<{ id: number; name: string }>(c, 'SELECT id, name FROM categories WHERE id IN (?) ORDER BY name', [ids]);
}

/**
 * A distributor set up with categories may only list products in those (or their sub-categories). A product in any other
 * category would be invisible to the retailers who were given categories, which nobody wants to discover by accident.
 * Distributors with no categories (signed up by themselves) are not restricted. Uncategorised products are allowed.
 */
export async function assertCategoryAllowed(c: Conn, distributorId: number, name: string | null | undefined) {
  if (!name || !name.trim()) return;
  const mine = await idsOf(c, 'distributor_categories', 'distributor_id', distributorId);
  if (!mine.length) return;
  const all = await allCategories(c);
  const allowed = withDescendants(all, mine);
  const row = await q1<{ id: number }>(c, "SELECT id FROM categories WHERE name_key = ? AND status <> 'retired' ORDER BY id LIMIT 1", [name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 80)]);
  if (!row || !allowed.has(row.id)) throw new AppError(400, 'CATEGORY_NOT_YOURS', `"${name.trim()}" is not one of your categories. Choose one from your list, or ask the company to add a sub-category.`);
}

/** The categories (with their sub-categories) a distributor may list products in; null when it is not restricted. */
export async function listableCategories(c: Conn, distributorId: number): Promise<{ id: number; name: string; parent_id: number | null; status: string }[] | null> {
  const mine = await idsOf(c, 'distributor_categories', 'distributor_id', distributorId);
  if (!mine.length) return null;
  const all = await allCategories(c);
  const ok = withDescendants(all, mine);
  return q(c, "SELECT id, name, parent_id, status FROM categories WHERE id IN (?) AND status <> 'retired' ORDER BY name", [[...ok]]);
}

/**
 * PRIVATE PRODUCTS
 * A product with rows in product_audience belongs to those retailers alone: nobody else can see it, see its price, search for
 * it, download it, or order it. A product with none is open to everyone (as before). `col` is the product id column to test.
 */
export function audienceClause(retailerId: number | undefined, col = 'products.id'): { sql: string; args: unknown[] } {
  const none = `NOT EXISTS (SELECT 1 FROM product_audience pa WHERE pa.product_id = ${col})`;
  if (!retailerId) return { sql: ` AND ${none}`, args: [] };
  return { sql: ` AND (${none} OR EXISTS (SELECT 1 FROM product_audience pa WHERE pa.product_id = ${col} AND pa.retailer_id = ?))`, args: [retailerId] };
}
