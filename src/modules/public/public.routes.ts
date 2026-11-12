import { Router } from 'express';
import { z } from 'zod';
import { pool, q } from '../../db/pool';
import { env } from '../../config/env';
import { asyncHandler } from '../../utils/errors';
import { storefrontProducts } from '../catalog/catalog.routes';

/**
 * The public shop window: list prices of products that distributors have published (active, approved, not kept for chosen
 * retailers). No login. A retailer's own contract prices and the exact stock are NOT part of it; ordering still needs a sign-in.
 * PUBLIC_CATALOG=off switches it off.
 */
export const publicRouter = Router();

publicRouter.get('/products', asyncHandler(async (req, res) => {
  if (process.env.PUBLIC_CATALOG === 'off') { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }); return; }
  const qs = z.object({
    q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(120).default(60), offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);

  // distributors that are switched on and whose subscription is live (the free testing period never expires them)
  const sellers = await q<any>(pool, `SELECT dp.user_id id, dp.business_name, dp.city FROM distributor_profiles dp JOIN users u ON u.id = dp.user_id
    WHERE u.is_active = 1 AND (? = 1 OR dp.subscription_ends_at > UTC_TIMESTAMP()) ORDER BY dp.user_id`, [env.freeOnboarding ? 1 : 0]);

  const all: any[] = []; const categories = new Set<string>();
  for (const s of sellers) {
    const r = await storefrontProducts(s.id, { q: qs.q, category: qs.category, limit: 200 });
    r.categories.forEach((c: string) => categories.add(c));
    for (const p of r.products as any[]) {
      all.push({ ...p, stock_qty: Math.min(Number(p.stock_qty ?? 0), 11), available_qty: Math.min(Number(p.available_qty ?? p.stock_qty ?? 0), 11), distributor_name: s.business_name, distributor_city: s.city });
    }
  }
  all.sort((a, b) => Number(b.stock_qty > 0) - Number(a.stock_qty > 0));
  res.json({ products: all.slice(qs.offset, qs.offset + qs.limit), total: all.length, categories: [...categories].sort() });
}));
