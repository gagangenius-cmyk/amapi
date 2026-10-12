import { Request } from 'express';
import { AppError } from './errors';

/** Read a positive integer route parameter; anything else is a clean 400 instead of a database error. */
export function idParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  if (!/^\d{1,15}$/.test(raw ?? '')) throw new AppError(400, 'BAD_ID', `Invalid ${name}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(400, 'BAD_ID', `Invalid ${name}`);
  return n;
}
