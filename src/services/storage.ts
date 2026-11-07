import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { exec, pool, q1 } from '../db/pool';

/**
 * File storage behind one small interface (put / read / remove), so product photos live on local disk by default and in any
 * S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces) by configuration alone:
 *   STORAGE=s3  S3_BUCKET=...  S3_REGION=...  [S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com]  + the usual AWS_* credentials.
 * Files are named by an unguessable random key and never overwritten.
 */
export interface Storage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  /** The file's bytes, or null when it does not exist. */
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const root = () => path.resolve(env.isTest ? path.join(env.uploadDir, '_test') : env.uploadDir);

export const localStorage_: Storage = {
  async put(key, data) {
    await fs.promises.mkdir(root(), { recursive: true });
    await fs.promises.writeFile(path.join(root(), key), data, { flag: 'wx' });
  },
  async read(key) {
    try { return await fs.promises.readFile(path.join(root(), key)); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  },
  async remove(key) { await fs.promises.rm(path.join(root(), key), { force: true }); },
};

/** Files in a MySQL table: for a host with no writable disk (a serverless platform) and no bucket configured. */
export const dbStorage: Storage = {
  async put(key, data, mime) { await exec(pool, 'INSERT INTO file_blobs (file_key, mime, data) VALUES (?,?,?)', [key, mime, data]); },
  async read(key) {
    const r = await q1<{ data: Buffer }>(pool, 'SELECT data FROM file_blobs WHERE file_key = ?', [key]);
    return r ? Buffer.from(r.data) : null;
  },
  async remove(key) { await exec(pool, 'DELETE FROM file_blobs WHERE file_key = ?', [key]); },
};

/** Vercel Blob (STORAGE=blob + BLOB_READ_WRITE_TOKEN). Keys are already unguessable and never overwritten. */
export const blobStorage: Storage = {
  async put(key, data, mime) {
    const { put } = await import('@vercel/blob');
    await put(`media/${key}`, data, { access: 'public', contentType: mime, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 });
  },
  async read(key) {
    const { head, BlobNotFoundError } = await import('@vercel/blob');
    try {
      const meta = await head(`media/${key}`);
      const r = await fetch(meta.url);
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    } catch (e: any) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  },
  async remove(key) {
    const { del } = await import('@vercel/blob');
    await del(`media/${key}`);
  },
};

/** Minimal slice of the AWS SDK client we use, so tests can plug in a fake. */
export interface S3Like { send(command: any): Promise<any> }

export function s3Storage(o: { bucket: string; client: S3Like; commands: { Put: any; Get: any; Delete: any }; prefix?: string }): Storage {
  const k = (key: string) => `${o.prefix ?? 'media/'}${key}`;
  return {
    async put(key, data, mime) { await o.client.send(new o.commands.Put({ Bucket: o.bucket, Key: k(key), Body: data, ContentType: mime, CacheControl: 'public, max-age=31536000, immutable' })); },
    async read(key) {
      try {
        const r = await o.client.send(new o.commands.Get({ Bucket: o.bucket, Key: k(key) }));
        const bytes = await r.Body?.transformToByteArray?.();
        return bytes ? Buffer.from(bytes) : null;
      } catch (e: any) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async remove(key) { await o.client.send(new o.commands.Delete({ Bucket: o.bucket, Key: k(key) })); },
  };
}

let current: Storage | null = null;
let override: Storage | null = null;
export const setStorage = (s: Storage | null) => { override = s; current = null; };

async function build(): Promise<Storage> {
  if (process.env.STORAGE === 'blob') return blobStorage;
  if (process.env.STORAGE === 's3') {
    if (!process.env.S3_BUCKET) throw new Error('STORAGE=s3 needs S3_BUCKET');
    const sdk = await import('@aws-sdk/client-s3');                  // loaded only when used: local setups do not need it
    const client = new sdk.S3Client({ region: process.env.S3_REGION ?? 'auto', ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }) });
    return s3Storage({ bucket: process.env.S3_BUCKET, client, commands: { Put: sdk.PutObjectCommand, Get: sdk.GetObjectCommand, Delete: sdk.DeleteObjectCommand } });
  }
  // a serverless host (Vercel) has a read-only disk: keep files in the database unless a bucket was configured
  if (process.env.STORAGE === 'db' || (process.env.VERCEL && process.env.STORAGE !== 'local')) return dbStorage;
  return localStorage_;
}

/** The configured storage. Resolved once, on first use. */
export const storage: Storage = {
  async put(key, data, mime) { return (override ?? (current ??= await build())).put(key, data, mime); },
  async read(key) { return (override ?? (current ??= await build())).read(key); },
  async remove(key) { return (override ?? (current ??= await build())).remove(key); },
};

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export const EXT: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Trust the bytes, not the Content-Type header. */
export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
