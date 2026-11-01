import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool } from '../src/db/pool';

const app = createApp();
let n = 0;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function admin() {
  const p = String(7600000000 + ++n);
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin', await bcrypt.hash('password123', 4)]);
  return (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
}

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('admin categories and sub-categories', () => {
  it('adds a sub-category, renames, moves, and refuses loops', async () => {
    const a = await admin(); const s = Date.now() % 100000;
    const post = (body: object) => request(app).post('/api/v1/admin/categories').set(auth(a)).send(body);
    const put = (id: number, body: object) => request(app).put(`/api/v1/admin/categories/${id}`).set(auth(a)).send(body);
    const root = (await post({ name: `Electronics ${s}` }).expect(201)).body.id as number;
    const phones = (await post({ name: `Phones ${s}`, parent_id: root }).expect(201)).body.id as number;
    const other = (await post({ name: `Appliances ${s}` }).expect(201)).body.id as number;

    const list = async () => (await request(app).get('/api/v1/admin/categories').set(auth(a)).expect(200)).body.items as any[];
    expect((await list()).find((c) => c.id === phones).parent_id).toBe(root);

    await put(phones, { name: `Mobile Phones ${s}` }).expect(200);                       // rename keeps its place
    expect((await list()).find((c) => c.id === phones)).toMatchObject({ name: `Mobile Phones ${s}`, parent_id: root });

    await put(phones, { parent_id: other }).expect(200);                                  // move under another category
    expect((await list()).find((c) => c.id === phones).parent_id).toBe(other);
    await put(phones, { parent_id: null }).expect(200);                                   // back to the top level
    expect((await list()).find((c) => c.id === phones).parent_id).toBeNull();

    await put(root, { parent_id: root }).expect(400);                                     // not under itself
    await put(phones, { parent_id: other }).expect(200);
    await put(other, { parent_id: phones }).expect(400);                                  // not under its own sub-category
  });
});
