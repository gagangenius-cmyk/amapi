import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A real download is never made in a test: this stands in for it, and fails like the real one for anything else.
vi.mock('../src/services/remoteImage', async (orig) => {
  const real = await orig<typeof import('../src/services/remoteImage')>();
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  return {
    ...real,
    fetchRemoteImage: async (url: string) => {
      if (url.includes('/ok')) return { bytes: PNG, mime: 'image/png' as const };
      throw new real.RemoteImageError(url.includes('/notimage') ? 'the link is not a JPEG, PNG or WebP picture' : 'the picture could not be downloaded (404)');
    },
  };
});

import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool, q, q1 } from '../src/db/pool';
import { assertPublicHttps, isPrivateAddress } from '../src/services/remoteImage';

const app = createApp();
let n = 0;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function distributor() {
  const p = String(8300000000 + ++n);
  const r = await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: p, email: `d${p}@c.test`, name: 'Owner', password: 'password123', business_name: 'Photo Biz ' + p });
  return { id: r.body.id as number, token: r.body.access_token as string };
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('photo links in the bulk import', () => {
  it('saves the main and other photos of each product, and reports the ones that fail without losing the product', async () => {
    const d = await distributor();
    const rows = [
      { name: 'With Photos', price: '100', sku: 'P1', image_url: 'https://pics.example/ok-front.png', other_image_urls: 'https://pics.example/ok-back.png | https://pics.example/ok-side.png' },
      { name: 'Bad Photo', price: '100', sku: 'P2', image_url: 'https://pics.example/missing.png' },
      { name: 'Not A Picture', price: '100', sku: 'P3', image_url: 'https://pics.example/notimage.html' },
      { name: 'No Photo', price: '100', sku: 'P4' },
    ];
    const r = (await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows, upsert: true }).expect(200)).body;
    expect(r.created).toBe(4);                                   // every product is saved, with or without a good photo
    expect(r.photos).toBe(3);
    expect(r.errors.map((e: any) => e.row)).toEqual([2, 3]);
    expect(r.errors[0].message).toMatch(/photo .*missing\.png.*product itself was saved/);
    expect(r.errors[1].message).toMatch(/not a JPEG, PNG or WebP/);

    const count = async (sku: string) => Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.sku = ? AND p.distributor_id = ?', [sku, d.id]))!.n);
    expect(await count('P1')).toBe(3);
    expect(await count('P2')).toBe(0);
    const pos = await q<any>(pool, "SELECT i.position FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.sku = 'P1' AND p.distributor_id = ? ORDER BY i.position", [d.id]);
    expect(pos.map((x) => x.position)).toEqual([0, 1, 2]);       // the main photo is the cover

    // importing the same file again does not pile up copies
    await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [rows[0]], upsert: true }).expect(200);
    expect(await count('P1')).toBe(3);
  });

  it('keeps at most five photos per product', async () => {
    const d = await distributor();
    const many = Array.from({ length: 8 }, (_, i) => `https://pics.example/ok-${i}.png`).join('|');
    await request(app).post('/api/v1/catalog/import/rows').set(auth(d.token)).send({ rows: [{ name: 'Many', price: '10', sku: 'M1', other_image_urls: many }] }).expect(200);
    expect(Number((await q1<any>(pool, "SELECT COUNT(*) n FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.sku = 'M1' AND p.distributor_id = ?", [d.id]))!.n)).toBe(5);
  });
});

describe('which addresses a photo may be fetched from', () => {
  it('recognises private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses plain http, logins in the address, odd ports and private hosts', async () => {
    await expect(assertPublicHttps('http://example.com/a.png')).rejects.toThrow(/https/);
    await expect(assertPublicHttps('https://user:pw@example.com/a.png')).rejects.toThrow(/login/);
    await expect(assertPublicHttps('https://example.com:8443/a.png')).rejects.toThrow(/port/);
    await expect(assertPublicHttps('https://127.0.0.1/a.png')).rejects.toThrow(/public/);
    await expect(assertPublicHttps('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/public/);
    await expect(assertPublicHttps('https://[::1]/a.png')).rejects.toThrow(/public/);
    await expect(assertPublicHttps('not a url')).rejects.toThrow(/valid web address/);
  });
});
