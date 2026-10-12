import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool, q1 } from '../db/pool';
import { AppError, forbidden } from '../utils/errors';

export type Role = 'admin' | 'distributor' | 'employee' | 'retailer' | 'company_employee';
const ROLES: Role[] = ['admin', 'distributor', 'employee', 'retailer', 'company_employee'];

export interface AuthCtx {
  userId: number;
  role: Role;
  /** distributor this principal acts for: self (distributor) or owner (employee) */
  distributorId?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthCtx;
  }
}

export function signAccess(ctx: AuthCtx): string {
  return jwt.sign(ctx, env.jwtSecret, { expiresIn: `${env.accessTtlMin}m`, algorithm: 'HS256' });
}

/** Verify an access token and return its claims. Rejects other kinds of token (e.g. the signed invoice link). */
export function verifyAccessToken(token: string): AuthCtx & { exp?: number } {
  const p = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] }) as any;
  if (p.purpose || typeof p.userId !== 'number' || !ROLES.includes(p.role)) throw new Error('not an access token');
  return { userId: p.userId, role: p.role, distributorId: p.distributorId, exp: p.exp };
}

// A deleted or deactivated account must stop working quickly, not when its 15-minute token expires.
// The check is cached briefly so it costs one tiny query per user every 30 seconds.
const ACTIVE_TTL_MS = 30_000;
const activeCache = new Map<number, { ok: boolean; until: number }>();
export const invalidateUser = (userId: number) => { activeCache.delete(userId); };

export async function isUserActive(userId: number): Promise<boolean> {
  const hit = activeCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.ok;
  const row = await q1<{ is_active: number }>(pool, 'SELECT is_active FROM users WHERE id = ?', [userId]);
  const ok = !!row && !!row.is_active;
  activeCache.set(userId, { ok, until: Date.now() + ACTIVE_TTL_MS });
  return ok;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(new AppError(401, 'UNAUTHENTICATED', 'Missing token'));
  let claims: AuthCtx;
  try {
    claims = verifyAccessToken(h.slice(7));
  } catch {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token'));
  }
  try {
    if (!(await isUserActive(claims.userId))) return next(new AppError(401, 'UNAUTHENTICATED', 'Account is no longer active'));
  } catch (e) {
    return next(e);
  }
  req.auth = { userId: claims.userId, role: claims.role, distributorId: claims.distributorId };
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) =>
    roles.includes(req.auth!.role) ? next() : next(forbidden('Role not permitted'));

export function idempotencyKey(req: Request): string {
  const k = req.header('Idempotency-Key');
  if (!k || k.length > 80) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (max 80 chars) is required');
  return k;
}

/** Admin and company-employee power needs a second factor (when enforced): checked on every request, so disabling it elsewhere takes effect at once. */
export async function requireTwoFactor(req: Request, _res: Response, next: NextFunction) {
  if (!env.adminRequires2fa || (req.auth?.role !== 'admin' && req.auth?.role !== 'company_employee')) return next();
  try {
    const u = await q1<any>(pool, 'SELECT totp_enabled_at FROM users WHERE id = ?', [req.auth.userId]);
    if (!u?.totp_enabled_at) return next(new AppError(403, 'TWO_FACTOR_REQUIRED', req.auth.role === 'admin' ? 'Turn on two-factor authentication to use admin features' : 'Turn on two-factor authentication (Account screen) to use this area'));
    next();
  } catch (e) { next(e); }
}
