import { z } from 'zod';

/**
 * Social links a distributor shows on its store. Only https links to the real site are kept: a retailer taps these, so a link
 * to anywhere else (or a javascript: / intent: link) must never be stored. WhatsApp can be given as a phone number.
 */
export const SOCIAL_KEYS = ['whatsapp', 'facebook', 'instagram', 'youtube', 'maps'] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];
export type SocialLinks = Partial<Record<SocialKey, string>>;

const HOST: Record<Exclude<SocialKey, 'whatsapp'>, (host: string, path: string) => boolean> = {
  facebook: (h) => /^(www\.|m\.|web\.)?facebook\.com$/.test(h) || h === 'fb.com' || h === 'www.fb.com' || h === 'fb.me',
  instagram: (h) => /^(www\.)?instagram\.com$/.test(h) || h === 'instagr.am',
  youtube: (h) => /^(www\.|m\.)?youtube\.com$/.test(h) || h === 'youtu.be',
  maps: (h, p) => h === 'maps.app.goo.gl' || h === 'maps.google.com' || ((h === 'goo.gl' || /^(www\.)?google\.(com|co\.in)$/.test(h)) && p.startsWith('/maps')),
};

const toUrl = (raw: string): URL | null => {
  const s = raw.trim();
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
};

/** The cleaned link, or null when it is not acceptable. An empty string means "remove". */
export function cleanSocial(key: SocialKey, raw: string): string | null | 'remove' {
  const s = raw.trim();
  if (!s) return 'remove';
  if (s.length > 300) return null;
  if (key === 'whatsapp') {
    const digits = s.replace(/[\s\-()+]/g, '');
    if (/^\d{10}$/.test(digits)) return `https://wa.me/91${digits}`;
    if (/^\d{11,15}$/.test(digits)) return `https://wa.me/${digits}`;
    const u = toUrl(s);
    return u && u.protocol === 'https:' && (u.hostname === 'wa.me' || u.hostname === 'api.whatsapp.com' || u.hostname === 'chat.whatsapp.com') ? u.toString() : null;
  }
  const u = toUrl(s);
  if (!u || u.protocol !== 'https:' || u.username || u.password) return null;
  return HOST[key](u.hostname.toLowerCase(), u.pathname) ? u.toString() : null;
}

/** Input shape for the API: each key optional; "" removes one. */
export const socialInput = z.object(Object.fromEntries(SOCIAL_KEYS.map((k) => [k, z.string().max(300).optional()]))).strict();

/** Merge an update into what is stored. Throws a readable message naming the bad field. */
export function mergeSocial(current: SocialLinks, input: Record<string, string | undefined>): SocialLinks {
  const out: SocialLinks = { ...current };
  for (const key of SOCIAL_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    const c = cleanSocial(key, raw);
    if (c === null) throw new Error(`${key}: that is not a valid ${key === 'maps' ? 'Google Maps' : key[0].toUpperCase() + key.slice(1)} link`);
    if (c === 'remove') delete out[key]; else out[key] = c;
  }
  return out;
}

export const parseSocial = (raw: string | null | undefined): SocialLinks => {
  try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' ? (v as SocialLinks) : {}; } catch { return {}; }
};
