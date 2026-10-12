import crypto from 'crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, invalidateUser } from '../../middleware/auth';
import { createOtp, mailCode } from '../auth/auth.routes';
import { env } from '../../config/env';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler } from '../../utils/errors';

export const accountRouter = Router();
accountRouter.use(authenticate);

// Who am I: used by the app to show email status and role.
accountRouter.get('/', asyncHandler(async (req, res) => {
  const u = await q1<any>(pool, 'SELECT id, role, name, phone, email, email_verified_at, totp_enabled_at, created_at FROM users WHERE id = ?', [req.auth!.userId]);
  res.json({ id: u.id, role: u.role, name: u.name, phone: u.phone, email: u.email, email_verified: !!u.email_verified_at, ...((u.role === 'admin' || u.role === 'company_employee') && { two_factor: !!u.totp_enabled_at }), created_at: u.created_at });
}));

// Everything we hold about the signed-in user (privacy / data-portability request).
accountRouter.get('/export', asyncHandler(async (req, res) => {
  const id = req.auth!.userId;
  const user = await q1<any>(pool, 'SELECT id, role, phone, name, email, owner_distributor_id, created_at FROM users WHERE id = ?', [id]);
  const data = {
    exported_at: new Date().toISOString(),
    user,
    retailer_profile: await q1(pool, 'SELECT * FROM retailer_profiles WHERE user_id = ?', [id]),
    distributor_profile: await q1(pool, 'SELECT user_id, business_name, gst_no, subscription_ends_at, commission_rate_bps FROM distributor_profiles WHERE user_id = ?', [id]),
    orders: await q(pool, 'SELECT * FROM orders WHERE retailer_id = ? OR distributor_id = ? ORDER BY id', [id, id]),
    ledger: await q(pool, 'SELECT * FROM ledger_transactions WHERE retailer_id = ? OR distributor_id = ? ORDER BY id', [id, id]),
    payments: await q(pool, 'SELECT * FROM payment_intents WHERE retailer_id = ? OR distributor_id = ? ORDER BY id', [id, id]),
    messages: await q(pool, 'SELECT * FROM chat_messages WHERE retailer_id = ? OR distributor_id = ? OR sender_id = ? ORDER BY id', [id, id, id]),
  };
  await audit(id, 'account.export', 'user', id);
  res.setHeader('Content-Disposition', 'attachment; filename="aayme-data-export.json"');
  res.json(data);
}));

// Add or change the email that receives sign-in / password-reset codes. Needs the password.
accountRouter.put('/email', asyncHandler(async (req, res) => {
  const b = z.object({ email: z.string().trim().toLowerCase().email().max(190), password: z.string() }).parse(req.body);
  const u = await q1<any>(pool, 'SELECT * FROM users WHERE id = ?', [req.auth!.userId]);
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong password');
  // an address nobody has confirmed does not reserve it (same rule as registration)
  await exec(pool, 'UPDATE users SET email = NULL WHERE email = ? AND id <> ? AND email_verified_at IS NULL', [b.email, u.id]);
  if (await q1(pool, 'SELECT id FROM users WHERE email = ? AND id <> ?', [b.email, u.id])) throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
  try {
    await exec(pool, 'UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?', [b.email, u.id]);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
    throw e;
  }
  await audit(u.id, 'account.email_change', 'user', u.id);
  let devCode: string | undefined;
  try { const code = await createOtp(pool, `verify:${b.email}`, 'verify'); if (await mailCode(b.email, code, 'verify', u.id) && env.otpDevEcho) devCode = code; } catch { /* the app offers "send code again" */ }
  res.json({ email: b.email, email_verified: false, ...(devCode ? { dev_code: devCode } : {}) });
}));

/**
 * Account deletion = anonymisation. Personal details and credentials are removed, but orders and ledger
 * rows are kept (financial records must be retained) and now point to an anonymous user.
 * Refused while money is owed or orders are open, so the other party is never left hanging.
 */
accountRouter.delete('/', asyncHandler(async (req, res) => {
  const { password } = z.object({ password: z.string() }).parse(req.body);
  const a = req.auth!;
  if (a.role === 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin accounts cannot be self-deleted');
  const u = await q1<any>(pool, 'SELECT * FROM users WHERE id = ?', [a.userId]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong password');

  await withTx(async (c) => {
    if (a.role === 'retailer' || a.role === 'distributor') {
      const col = a.role === 'retailer' ? 'retailer_id' : 'distributor_id';
      const bal = await q1<any>(c, `SELECT COUNT(*) n FROM retailer_distributor_relations WHERE ${col} = ? AND balance_due_paise <> 0`, [a.userId]);
      if (Number(bal.n) > 0) throw new AppError(409, 'OUTSTANDING_BALANCE', 'Settle all khata balances before deleting your account');
      const open = await q1<any>(c, `SELECT COUNT(*) n FROM orders WHERE ${col} = ? AND status IN ('placed','accepted','dispatched','out_for_delivery')`, [a.userId]);
      if (Number(open.n) > 0) throw new AppError(409, 'OPEN_ORDERS', 'Complete or cancel open orders before deleting your account');
    }
    if (a.role === 'distributor') {
      await exec(c, "UPDATE users SET is_active = 0 WHERE owner_distributor_id = ? AND role = 'employee'", [a.userId]);
      await exec(c, 'UPDATE distributor_profiles SET subscription_ends_at = UTC_TIMESTAMP(), bank_account_details = NULL, gst_no = NULL WHERE user_id = ?', [a.userId]);
      await exec(c, 'UPDATE products SET is_active = 0, deleted_at = UTC_TIMESTAMP() WHERE distributor_id = ? AND deleted_at IS NULL', [a.userId]);
    }
    if (a.role === 'retailer') await exec(c, "UPDATE retailer_profiles SET shop_name = 'Deleted shop', address = NULL WHERE user_id = ?", [a.userId]);
    await exec(c, "UPDATE users SET name = 'Deleted user', phone = ?, email = NULL, is_active = 0, password_hash = ? WHERE id = ?", [
      `D${a.userId}`, await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), a.userId,
    ]);
    await exec(c, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [a.userId]);
    await exec(c, 'DELETE FROM push_tokens WHERE user_id = ?', [a.userId]);
    await exec(c, "UPDATE chat_messages SET body = '[deleted]' WHERE sender_id = ?", [a.userId]);
  });
  invalidateUser(a.userId);
  await audit(a.userId, 'account.delete', 'user', a.userId);
  res.status(204).end();
}));

// Recent sign-ins and failed attempts on this account, newest first, so odd activity is easy to spot.
accountRouter.get('/login-history', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `SELECT id, action, meta, created_at FROM audit_log
    WHERE actor_id = ? AND action IN ('auth.login','auth.login_failed','auth.login_locked','auth.totp_failed') ORDER BY id DESC LIMIT 30`, [req.auth!.userId]);
  res.json({ entries: rows.map((r) => {
    const m = r.meta ? JSON.parse(r.meta) : {};
    return { id: r.id, ok: r.action === 'auth.login', event: r.action, at: r.created_at, ip: m.ip ?? null, device: m.device ?? null };
  }) });
}));

// ---------- devices / sessions ----------
// A session is one sign-in on one device; its refresh token is rotated but keeps the same session_id.
accountRouter.get('/sessions', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, `
    SELECT session_id, MIN(created_at) started_at, MAX(created_at) last_active_at, MAX(user_agent) user_agent, MAX(ip) ip
    FROM refresh_tokens WHERE user_id = ? AND session_id IS NOT NULL GROUP BY session_id
    HAVING SUM(revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()) > 0 ORDER BY last_active_at DESC LIMIT 20`, [req.auth!.userId]);
  res.json({ sessions: rows.map((r) => ({ id: r.session_id, started_at: r.started_at, last_active_at: r.last_active_at, device: r.user_agent, ip: r.ip })) });
}));

const revoke = (userId: number, where: string, args: unknown[]) =>
  exec(pool, `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL AND ${where}`, [userId, ...args]);

// "Sign out everywhere else": keeps the session that owns the refresh token you send.
accountRouter.post('/sessions/revoke-others', asyncHandler(async (req, res) => {
  const { refresh_token } = z.object({ refresh_token: z.string().min(10) }).parse(req.body);
  const mine = await q1<any>(pool, 'SELECT session_id FROM refresh_tokens WHERE user_id = ? AND token_hash = ?', [req.auth!.userId, crypto.createHash('sha256').update(refresh_token).digest('hex')]);
  if (!mine?.session_id) throw new AppError(400, 'BAD_REFRESH', 'Unknown session');
  const r = await revoke(req.auth!.userId, 'session_id <> ?', [mine.session_id]);
  await audit(req.auth!.userId, 'auth.sessions_revoked', 'user', req.auth!.userId, { count: r.affectedRows });
  res.json({ revoked: r.affectedRows });
}));

accountRouter.delete('/sessions/:sid', asyncHandler(async (req, res) => {
  const sid = z.string().regex(/^[a-f0-9]{32}$/).parse(req.params.sid);
  const r = await revoke(req.auth!.userId, 'session_id = ?', [sid]);
  if (!r.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  await audit(req.auth!.userId, 'auth.session_revoked', 'user', req.auth!.userId);
  res.status(204).end();
}));
