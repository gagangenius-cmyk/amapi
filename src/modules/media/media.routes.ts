import { Router } from 'express';
import { pool, q1 } from '../../db/pool';
import { EXT, storage } from '../../services/storage';
import { asyncHandler } from '../../utils/errors';

/** Product photos. Public by design (the storefront shows them): the 160-bit random name is the access control, and they never change. */
export const mediaRouter = Router();

mediaRouter.get('/:key', asyncHandler(async (req, res) => {
  const key = req.params.key;
  const img = /^[a-f0-9]{40}$/.test(key) ? await q1<any>(pool, 'SELECT mime FROM product_images WHERE file_key = ?', [key]) : undefined;
  if (!img) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // the web app loads these from another origin
  const bytes = await storage.read(`${key}.${EXT[img.mime as keyof typeof EXT]}`);
  if (!bytes) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });
  res.end(bytes);
}));
