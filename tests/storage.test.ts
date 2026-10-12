import http from 'http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { setStorage, storage } from '../src/services/storage';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

/** A tiny S3 look-alike (path-style PUT / GET / DELETE) so the REAL AWS SDK client is exercised end to end. */
let s3: http.Server; let endpoint = ''; const objects = new Map<string, { body: Buffer; type: string; cache: string | undefined }>(); const seen: string[] = [];
beforeAll(async () => {
  await migrate(true);
  s3 = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const key = decodeURIComponent((req.url ?? '').split('?')[0]);
      seen.push(`${req.method} ${key} auth=${/AWS4-HMAC-SHA256/.test(req.headers.authorization ?? '')}`);
      if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']), cache: req.headers['cache-control'] as string | undefined }); res.statusCode = 200; return void res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return void res.end(); }
      const o = objects.get(key);
      if (!o) { res.statusCode = 404; res.setHeader('Content-Type', 'application/xml'); return void res.end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>'); }
      res.setHeader('Content-Type', o.type); res.end(o.body);
    });
  });
  await new Promise<void>((ok) => s3.listen(0, '127.0.0.1', ok));
  endpoint = `http://127.0.0.1:${(s3.address() as any).port}`;
});
afterEach(() => { setStorage(null); delete process.env.STORAGE; });
afterAll(async () => { s3.close(); await pool.end(); });

describe('S3-compatible photo storage', () => {
  it('stores, serves and deletes product photos through the real AWS SDK', async () => {
    process.env.STORAGE = 's3'; process.env.S3_BUCKET = 'aayme-media'; process.env.S3_ENDPOINT = endpoint; process.env.S3_REGION = 'auto';
    process.env.AWS_ACCESS_KEY_ID = 'test'; process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    setStorage(null);

    const p = Math.floor(Math.random() * 9e6) + 1e6;
    const d = (await request(app).post('/api/v1/auth/register').send({ role: 'distributor', phone: '95' + p + '1', email: `s3${p}@t.local`, name: 'Sam Owner', password: 'password123', business_name: 'S3 Biz' }).expect(201)).body;
    const prod = (await request(app).post('/api/v1/catalog').set(auth(d.access_token)).send({ name: 'Cloud Rice', price: '10', stock_qty: 1 })).body;

    const up = await request(app).post(`/api/v1/catalog/${prod.id}/images`).set(auth(d.access_token)).set('Content-Type', 'image/png').send(png()).expect(201);
    const url = up.body.images[0].url as string;
    expect(objects.size).toBe(1);
    const [objKey, obj] = [...objects.entries()][0];
    expect(objKey).toMatch(/^\/aayme-media\/media\/[a-f0-9]{40}\.png$/);
    expect(obj.type).toBe('image/png');
    expect(obj.cache).toContain('immutable');
    expect(obj.body.equals(png())).toBe(true);
    expect(seen.every((x) => x.endsWith('auth=true'))).toBe(true);                // every request was signed

    const got = await request(app).get(url).expect(200);
    expect(got.headers['content-type']).toContain('image/png');
    expect(Buffer.from(got.body).equals(png())).toBe(true);

    await request(app).delete(`/api/v1/catalog/${prod.id}/images/${up.body.images[0].id}`).set(auth(d.access_token)).expect(200);
    expect(objects.size).toBe(0);
    await request(app).get(url).expect(404);
  });

  it('a photo that vanished from the bucket is a clean 404, not a crash', async () => {
    process.env.STORAGE = 's3'; process.env.S3_BUCKET = 'aayme-media'; process.env.S3_ENDPOINT = endpoint;
    process.env.AWS_ACCESS_KEY_ID = 'test'; process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    setStorage(null);
    expect(await storage.read('f'.repeat(40) + '.png')).toBeNull();
  });

  it('refuses to start in s3 mode without a bucket', async () => {
    process.env.STORAGE = 's3'; delete process.env.S3_BUCKET;
    setStorage(null);
    await expect(storage.read('x.png')).rejects.toThrow(/S3_BUCKET/);
  });

  it('uses local disk by default', async () => {
    setStorage(null);
    await storage.put('unit-test-file.bin', Buffer.from('hello'), 'application/octet-stream');
    expect((await storage.read('unit-test-file.bin'))?.toString()).toBe('hello');
    await storage.remove('unit-test-file.bin');
    expect(await storage.read('unit-test-file.bin')).toBeNull();
  });
});
