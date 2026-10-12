import crypto from 'crypto';
import { env } from '../config/env';

/** RFC 6238 time-based one-time passwords (Google Authenticator / Authy compatible), with no extra dependency. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

export const newSecret = () => base32(crypto.randomBytes(20));

export function codeAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Returns the matched time step (so the caller can refuse a replay of the same code) or null. Accepts one step either side for clock drift. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    const want = Buffer.from(codeAt(secret, s)), got = Buffer.from(code);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return s;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string) =>
  `otpauth://totp/AAYME:${encodeURIComponent(account)}?secret=${secret}&issuer=AAYME&period=30&digits=6`;

// The secret is stored encrypted (AES-256-GCM, key derived from JWT_SECRET) so a database leak alone does not expose it.
const key = () => crypto.createHash('sha256').update(`totp:${env.jwtSecret}`).digest();
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
