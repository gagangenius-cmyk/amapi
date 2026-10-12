import { Router } from 'express';
import { z } from 'zod';
import { exec, pool } from '../../db/pool';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../utils/errors';

export const deviceRouter = Router();
deviceRouter.use(authenticate);

// Register / move an Expo push token to the signed-in user.
deviceRouter.post('/', asyncHandler(async (req, res) => {
  const b = z.object({ token: z.string().min(10).max(200), platform: z.string().max(10).optional() }).parse(req.body);
  await exec(pool, 'INSERT INTO push_tokens (user_id, token, platform) VALUES (?,?,?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform)', [req.auth!.userId, b.token, b.platform ?? null]);
  res.status(204).end();
}));

deviceRouter.delete('/', asyncHandler(async (req, res) => {
  const b = z.object({ token: z.string() }).parse(req.body);
  await exec(pool, 'DELETE FROM push_tokens WHERE token = ? AND user_id = ?', [b.token, req.auth!.userId]);
  res.status(204).end();
}));
