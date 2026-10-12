import crypto from 'crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env';
import { Conn, exec, pool, q1, withTx } from '../../db/pool';
import { authenticate, AuthCtx, signAccess } from '../../middleware/auth';
import { AppError, asyncHandler } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { logger } from '../../utils/logger';
import { otpEmail, sendMail } from '../../services/mailer';
import { DEFAULT_PERMISSIONS } from '../distributors/subscription';
import * as totp from '../../utils/totp';

export const authRouter = Router();

const phone = z.string().regex(/^\d{10}$/, '10-digit phone');
// Stored lower-case so lookups and the unique index are case-insensitive. OTP codes are emailed here.
const email = z.string().trim().toLowerCase().email().max(190);
const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters');
const registerSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('retailer'),
    phone, email, name: z.string().min(2).max(120), password: z.string().min(8).max(100),
    shop_name: z.string().min(2).max(190), pincode: z.string().regex(/^\d{6}$/), address: z.string().max(255).optional(),
    gst_no: gstin.optional(),
  }),
  z.object({
    role: z.literal('distributor'),
    phone, email, name: z.string().min(2).max(120), password: z.string().min(8).max(100),
    business_name: z.string().min(2).max(190), gst_no: gstin.optional(),
  }),
]);

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

export interface SessionMeta { sessionId?: string; req?: { headers: Record<string, any>; ip?: string } }

/** Starts (or, on refresh, continues) a device session: every rotated refresh token keeps the same session_id. */
export async function issueTokens(userId: number, role: AuthCtx['role'], ownerDistributorId: number | null, meta: SessionMeta = {}) {
  const ctx: AuthCtx = { userId, role, distributorId: role === 'distributor' ? userId : ownerDistributorId ?? undefined };
  const refresh = crypto.randomBytes(48).toString('hex');
  const sessionId = meta.sessionId ?? crypto.randomBytes(16).toString('hex');
  const ua = meta.req?.headers['user-agent'] ? String(meta.req.headers['user-agent']).slice(0, 200) : null;
  await exec(pool, 'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_id, user_agent, ip) VALUES (?,?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), ?,?,?)', [
    userId, sha(refresh), env.refreshTtlDays, sessionId, ua, meta.req?.ip ?? null,
  ]);
  return { access_token: signAccess(ctx), refresh_token: refresh, expires_in: env.accessTtlMin * 60 };
}

// ---------- one-time codes (login, password reset, email verification) ----------
const OTP_TTL_MIN = 5;
type OtpPurpose = 'login' | 'reset' | 'verify';
const otpHash = (identifier: string, code: string) => sha(`${identifier}:${code}:${env.jwtSecret}`);

/** Create a code; throws 429 when too many were requested for this identifier recently. */
export async function createOtp(c: Conn, identifier: string, purpose: OtpPurpose): Promise<string> {
  const recent = await q1<any>(c, 'SELECT COUNT(*) n FROM otps WHERE identifier = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)', [identifier]);
  if (Number(recent.n) >= 3) throw new AppError(429, 'OTP_RATE_LIMIT', 'Too many codes requested. Try again in a few minutes.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await exec(c, 'INSERT INTO otps (identifier, purpose, code_hash, expires_at) VALUES (?,?,?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))', [identifier, purpose, otpHash(identifier, code), OTP_TTL_MIN]);
  return code;
}

/** Check and consume a code (single use, 5 attempts). Returns silently on success, throws BAD_OTP otherwise. */
async function consumeOtp(identifier: string, purpose: OtpPurpose, code: string) {
  const bad = () => new AppError(401, 'BAD_OTP', 'Invalid or expired code');
  const o = await q1<any>(pool, 'SELECT * FROM otps WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1', [identifier, purpose]);
  if (!o || new Date(o.expires_at).getTime() < Date.now() || o.attempts >= 5) throw bad();
  if (o.code_hash !== otpHash(identifier, code)) {
    await exec(pool, 'UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [o.id]);
    throw bad();
  }
  // Atomic single-use: only one concurrent verify can consume the code.
  const used = await exec(pool, 'UPDATE otps SET consumed_at = UTC_TIMESTAMP() WHERE id = ? AND consumed_at IS NULL', [o.id]);
  if (!used.affectedRows) throw bad();
}

export async function mailCode(to: string, code: string, purpose: OtpPurpose, userId: number): Promise<boolean> {
  try { await sendMail(otpEmail(to, code, OTP_TTL_MIN, purpose)); return true; }
  catch (err) { logger.error({ err, userId }, 'OTP email failed'); return false; }
}

// ---------- register / login / refresh / logout ----------
authRouter.post('/register', asyncHandler(async (req, res) => {
  const b = registerSchema.parse(req.body);
  const hash = await bcrypt.hash(b.password, 10);
  let id: number;
  try {
    id = await withTx(async (c) => {
      if (await q1(c, 'SELECT id FROM users WHERE phone = ?', [b.phone])) throw new AppError(409, 'PHONE_TAKEN', 'Phone already registered');
      // An email nobody has proven they own does not reserve the address: this stops anyone blocking a real person's email.
      await exec(c, 'UPDATE users SET email = NULL WHERE email = ? AND email_verified_at IS NULL', [b.email]);
      if (await q1(c, 'SELECT id FROM users WHERE email = ?', [b.email])) throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
      const u = await exec(c, 'INSERT INTO users (role, phone, email, name, password_hash) VALUES (?,?,?,?,?)', [b.role, b.phone, b.email, b.name, hash]);
      if (b.role === 'retailer') {
        await exec(c, 'INSERT INTO retailer_profiles (user_id, shop_name, pincode, address, gst_no) VALUES (?,?,?,?,?)', [u.insertId, b.shop_name, b.pincode, b.address ?? null, b.gst_no ?? null]);
      } else {
        // 30-day trial subscription
        await exec(c, 'INSERT INTO distributor_profiles (user_id, business_name, gst_no, permissions, subscription_ends_at) VALUES (?,?,?,?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY))', [
          u.insertId, b.business_name, b.gst_no ?? null, JSON.stringify(DEFAULT_PERMISSIONS),
        ]);
      }
      return u.insertId;
    });
  } catch (e: any) {
    // two sign-ups racing for the same phone/email: the database's unique index decides, and the loser gets a clean 409
    if (e?.code === 'ER_DUP_ENTRY') {
      const field = String(e.message).includes('uq_users_email') ? 'EMAIL' : 'PHONE';
      throw new AppError(409, `${field}_TAKEN`, `${field === 'EMAIL' ? 'Email' : 'Phone'} already registered`);
    }
    throw e;
  }
  // ask them to confirm the email right away (the app shows a banner until they do)
  try { await mailCode(b.email, await createOtp(pool, `verify:${b.email}`, 'verify'), 'verify', id); } catch { /* sign-up must not fail because of email */ }
  res.status(201).json({ id, ...(await issueTokens(id, b.role, null, { req })) });
}));

/**
 * Accounts with two-factor on must present a fresh authenticator code on EVERY credential path (password and emailed code),
 * otherwise the weaker path would bypass it. A wrong code counts toward the lockout like a wrong password.
 */
async function requireSecondFactor(u: any, code?: string) {
  if (!u.totp_enabled_at) return;
  if (!code) throw new AppError(401, 'TOTP_REQUIRED', 'Enter the 6-digit code from your authenticator app');
  const step = totp.verifyTotp(totp.open(u.totp_secret), code);
  if (step == null || (u.totp_last_step != null && step <= Number(u.totp_last_step))) {
    await audit(u.id, 'auth.totp_failed', 'user', u.id);
    await exec(pool, `UPDATE users SET locked_until = IF(failed_logins + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until),
      failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1) WHERE id = ?`, [MAX_FAILED_LOGINS, LOCK_MINUTES, MAX_FAILED_LOGINS, u.id]);
    throw new AppError(401, 'BAD_TOTP', 'That code is wrong or was already used');
  }
  await exec(pool, 'UPDATE users SET totp_last_step = ? WHERE id = ?', [step, u.id]); // a code works once
}

authRouter.post('/login', asyncHandler(async (req, res) => {
  const b = z.object({ phone, password: z.string(), totp: z.string().regex(/^\d{6}$/).optional() }).parse(req.body);
  const u = await q1<any>(pool, 'SELECT * FROM users WHERE phone = ?', [b.phone]);
  if (u?.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000);
    await audit(u.id, 'auth.login_locked', 'user', u.id);
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many wrong passwords. Try again in ${mins} minute${mins > 1 ? 's' : ''}, or sign in with an emailed code.`);
  }
  // compare against a dummy hash when the user is missing so timing stays uniform
  const ok = await bcrypt.compare(b.password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok || !u.is_active) {
    await audit(u?.id ?? null, 'auth.login_failed', 'user', u?.id ?? null, { phone: b.phone });
    if (u) {
      // lock the ACCOUNT (not just the IP) after repeated failures; emailed-code sign-in still works
      await exec(pool, `UPDATE users SET locked_until = IF(failed_logins + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until),
        failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1) WHERE id = ?`, [MAX_FAILED_LOGINS, LOCK_MINUTES, MAX_FAILED_LOGINS, u.id]);
    }
    throw new AppError(401, 'BAD_CREDENTIALS', 'Invalid phone or password');
  }
  await requireSecondFactor(u, b.totp);
  if (u.failed_logins || u.locked_until) await exec(pool, 'UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
  res.json({ id: u.id, role: u.role, ...(await issueTokens(u.id, u.role, u.owner_distributor_id, { req })) });
}));

authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);
  const out = await withTx(async (c) => {
    const t = await q1<any>(c, 'SELECT * FROM refresh_tokens WHERE token_hash = ? FOR UPDATE', [sha(refresh_token)]);
    if (!t) throw new AppError(401, 'BAD_REFRESH', 'Invalid refresh token');
    if (t.revoked_at) {
      // A token that was ROTATED away but is presented again means two parties hold copies: assume theft and end that session.
      // A token from a session that was signed out on purpose (no live token left) is just refused; it must not sign out the user's other devices.
      const live = t.session_id && await q1(c, 'SELECT 1 FROM refresh_tokens WHERE user_id = ? AND session_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() LIMIT 1', [t.user_id, t.session_id]);
      if (live) {
        await exec(c, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND session_id = ? AND revoked_at IS NULL', [t.user_id, t.session_id]);
        return { reuse: true as const };
      }
      throw new AppError(401, 'BAD_REFRESH', 'This session was signed out');
    }
    if (new Date(t.expires_at).getTime() < Date.now()) throw new AppError(401, 'BAD_REFRESH', 'Refresh token expired');
    await exec(c, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [t.id]);
    const u = await q1<any>(c, 'SELECT * FROM users WHERE id = ? AND is_active = 1', [t.user_id]);
    if (!u) throw new AppError(401, 'BAD_REFRESH', 'User inactive');
    return { reuse: false as const, u, sessionId: t.session_id as string | null };
  });
  if (out.reuse) throw new AppError(401, 'REFRESH_REUSED', 'Refresh token reuse detected; sign in again');
  res.json(await issueTokens(out.u.id, out.u.role, out.u.owner_distributor_id, { sessionId: out.sessionId ?? undefined, req }));
}));

authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [req.auth!.userId]);
  res.status(204).end();
}));

// ---------- OTP sign-in / password reset (code is EMAILED to the address on the account) ----------
// The person identifies themselves by email or phone.
const identifierSchema = z.string().trim().min(5).max(190).transform((s) => (s.includes('@') ? s.toLowerCase() : s));
const findByIdentifier = (identifier: string) =>
  q1<any>(pool, 'SELECT * FROM users WHERE (email = ? OR phone = ?) AND is_active = 1 LIMIT 1', [identifier, identifier]);

authRouter.post('/otp/request', asyncHandler(async (req, res) => {
  const b = z.object({ identifier: identifierSchema, purpose: z.enum(['login', 'reset']) }).parse(req.body);
  // Same response whether or not the account exists (or has an email), so accounts can't be enumerated.
  const user = await findByIdentifier(b.identifier);
  const code = await createOtp(pool, b.identifier, b.purpose);
  const delivered = user?.email ? await mailCode(user.email, code, b.purpose, user.id) : false;
  res.status(202).json({ sent: true, ...(env.otpDevEcho && delivered ? { dev_code: code } : {}) });
}));

authRouter.post('/otp/verify', asyncHandler(async (req, res) => {
  const b = z.object({ identifier: identifierSchema, purpose: z.enum(['login', 'reset']), code: z.string().regex(/^\d{6}$/), new_password: z.string().min(8).max(100).optional(), totp: z.string().regex(/^\d{6}$/).optional() }).parse(req.body);
  if (b.purpose === 'reset' && !b.new_password) throw new AppError(400, 'VALIDATION', 'new_password required');
  await consumeOtp(b.identifier, b.purpose, b.code);
  const u = await findByIdentifier(b.identifier);
  if (!u) throw new AppError(401, 'BAD_OTP', 'Invalid or expired code');
  await requireSecondFactor(u, b.totp);
  // receiving the code proves control of the inbox
  if (u.email && !u.email_verified_at) await exec(pool, 'UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ?', [u.id]);
  if (b.purpose === 'reset') {
    await exec(pool, 'UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [await bcrypt.hash(b.new_password!, 10), u.id]);
    await exec(pool, 'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [u.id]);
    await audit(u.id, 'auth.password_reset', 'user', u.id);
  }
  res.json({ id: u.id, role: u.role, ...(await issueTokens(u.id, u.role, u.owner_distributor_id)) });
}));

// ---------- confirm the account's email ----------
authRouter.post('/email/send-verification', authenticate, asyncHandler(async (req, res) => {
  const u = await q1<any>(pool, 'SELECT id, email, email_verified_at FROM users WHERE id = ?', [req.auth!.userId]);
  if (!u?.email) throw new AppError(409, 'NO_EMAIL', 'Add an email address first');
  if (u.email_verified_at) return res.json({ verified: true });
  const code = await createOtp(pool, `verify:${u.email}`, 'verify');
  const delivered = await mailCode(u.email, code, 'verify', u.id);
  res.status(202).json({ sent: true, ...(env.otpDevEcho && delivered ? { dev_code: code } : {}) });
}));

authRouter.post('/email/verify', authenticate, asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const u = await q1<any>(pool, 'SELECT id, email FROM users WHERE id = ?', [req.auth!.userId]);
  if (!u?.email) throw new AppError(409, 'NO_EMAIL', 'Add an email address first');
  await consumeOtp(`verify:${u.email}`, 'verify', code);
  await exec(pool, 'UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ?', [u.id]);
  await audit(u.id, 'auth.email_verified', 'user', u.id);
  res.json({ verified: true });
}));

// ---------- two-factor (authenticator app) for admin accounts ----------
authRouter.post('/2fa/setup', authenticate, asyncHandler(async (req, res) => {
  const u = await q1<any>(pool, 'SELECT id, phone, totp_enabled_at FROM users WHERE id = ?', [req.auth!.userId]);
  if (req.auth!.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Two-factor is for admin accounts');
  if (u.totp_enabled_at) throw new AppError(409, 'ALREADY_ENABLED', 'Two-factor is already on');
  const secret = totp.newSecret();
  await exec(pool, 'UPDATE users SET totp_secret = ? WHERE id = ?', [totp.seal(secret), u.id]);
  res.json({ secret, otpauth_url: totp.otpauthUrl(secret, u.phone) });
}));

authRouter.post('/2fa/enable', authenticate, asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const u = await q1<any>(pool, 'SELECT id, totp_secret, totp_enabled_at FROM users WHERE id = ?', [req.auth!.userId]);
  if (u.totp_enabled_at || !u.totp_secret) throw new AppError(409, 'BAD_STATE', 'Start the setup first');
  const step = totp.verifyTotp(totp.open(u.totp_secret), code);
  if (step == null) throw new AppError(401, 'BAD_TOTP', 'That code is wrong');
  await exec(pool, 'UPDATE users SET totp_enabled_at = UTC_TIMESTAMP(), totp_last_step = ? WHERE id = ?', [step, u.id]);
  await audit(u.id, 'auth.2fa_enabled', 'user', u.id);
  res.json({ enabled: true });
}));

authRouter.post('/2fa/disable', authenticate, asyncHandler(async (req, res) => {
  const b = z.object({ code: z.string().regex(/^\d{6}$/), password: z.string() }).parse(req.body);
  const u = await q1<any>(pool, 'SELECT * FROM users WHERE id = ?', [req.auth!.userId]);
  if (!u.totp_enabled_at) throw new AppError(409, 'BAD_STATE', 'Two-factor is not on');
  if (!(await bcrypt.compare(b.password, u.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong password');
  await requireSecondFactor(u, b.code);
  await exec(pool, 'UPDATE users SET totp_enabled_at = NULL, totp_secret = NULL, totp_last_step = NULL WHERE id = ?', [u.id]);
  await audit(u.id, 'auth.2fa_disabled', 'user', u.id);
  res.json({ enabled: false });
}));
