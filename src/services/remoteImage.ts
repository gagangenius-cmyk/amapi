import dns from 'node:dns/promises';
import net from 'node:net';
import { sniffImage } from './storage';

/** True for addresses a public image can never live at: this machine, private networks, link-local, carrier-grade NAT, multicast, metadata services. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));      // IPv4 written inside IPv6
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  }
  return true;   // not an address at all
}

export class RemoteImageError extends Error {}

/** Checks one address before it is fetched: https only, no login in the address, and a host that resolves to public addresses only. */
export async function assertPublicHttps(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new RemoteImageError('not a valid web address'); }
  if (u.protocol !== 'https:') throw new RemoteImageError('the link must start with https://');
  if (u.username || u.password) throw new RemoteImageError('the link must not contain a login');
  if (u.port && u.port !== '443') throw new RemoteImageError('the link must use the normal https port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw new RemoteImageError('the address could not be found'); })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new RemoteImageError('the address is not a public website');
  return u;
}

/**
 * Downloads one picture from a public https address for a bulk import. Redirects are followed (at most 3) and every hop is checked again;
 * the body is capped at 4 MB, the wait at 6 seconds, and only a real JPEG, PNG or WebP is accepted (judged from its bytes, not its name).
 */
export async function fetchRemoteImage(raw: string): Promise<{ bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  const MAX = 4 * 1024 * 1024;
  let url = await assertPublicHttps(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'AAYME-import/1.0', Accept: 'image/*' } })
      .catch(() => { throw new RemoteImageError('the picture could not be downloaded'); });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new RemoteImageError('the link redirects nowhere');
      url = await assertPublicHttps(new URL(next, url).toString());
      continue;
    }
    if (!res.ok) throw new RemoteImageError(`the picture could not be downloaded (${res.status})`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX) throw new RemoteImageError('the picture is larger than 4 MB');
    const chunks: Buffer[] = []; let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new RemoteImageError('the picture could not be downloaded');
    for (;;) {
      const { done, value } = await reader.read().catch(() => { throw new RemoteImageError('the picture could not be downloaded'); });
      if (done) break;
      size += value.length;
      if (size > MAX) { await reader.cancel().catch(() => {}); throw new RemoteImageError('the picture is larger than 4 MB'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    const mime = sniffImage(bytes);
    if (!mime) throw new RemoteImageError('the link is not a JPEG, PNG or WebP picture');
    return { bytes, mime };
  }
  throw new RemoteImageError('too many redirects');
}
