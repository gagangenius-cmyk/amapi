import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { pool } from '../src/db/pool';
import { dbStorage } from '../src/services/storage';

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('database file storage', () => {
  it('keeps, returns and removes a file; a missing one is null', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 2000 }, (_, i) => i % 256)]);
    await dbStorage.put('t-key.jpg', bytes, 'image/jpeg');
    const back = await dbStorage.read('t-key.jpg');
    expect(back && back.equals(bytes)).toBe(true);
    await dbStorage.remove('t-key.jpg');
    expect(await dbStorage.read('t-key.jpg')).toBeNull();
  });
});
