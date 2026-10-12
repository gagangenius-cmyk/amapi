import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { env } from '../src/config/env';
import { lockName } from '../src/db/pool';

export async function migrate(reset = false) {
  // Hard safety rail: dropping every table is only ever allowed on a database whose name ends in _test.
  if (reset && !(env.isTest && /_test$/.test(env.db.database))) {
    throw new Error(`Refusing to reset database "${env.db.database}": reset is only allowed for *_test databases in test mode`);
  }
  // The DB container may still be initialising on first boot; retry for up to ~60 s.
  const creds = { ...env.db, ...(env.migrateDb.user ? { user: env.migrateDb.user, password: env.migrateDb.password ?? '' } : {}), multipleStatements: true };
  let c!: mysql.Connection;
  for (let attempt = 1; ; attempt++) {
    try { c = await mysql.createConnection(creds); break; }
    catch (e: any) {
      // The database itself does not exist yet (fresh server): create it, then connect again.
      if (e?.code === 'ER_BAD_DB_ERROR' && !env.isProd) {
        const { database, ...noDb } = creds;
        const boot = await mysql.createConnection(noDb);
        await boot.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await boot.end();
        continue;
      }
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // Only one instance migrates at a time (several API servers may start together); the others wait, then find nothing to do.
  const [lk] = (await c.query('SELECT GET_LOCK(?, 120) AS got', [lockName('aayme_migrate')])) as any;
  if (!lk[0].got) throw new Error('Could not obtain the migration lock within 120 s');
  if (reset) {
    await c.query('SET FOREIGN_KEY_CHECKS=0');
    const [t] = (await c.query('SHOW TABLES')) as any;
    for (const r of t) await c.query(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``);
    await c.query('SET FOREIGN_KEY_CHECKS=1');
  }
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  const [done] = (await c.query('SELECT name FROM schema_migrations')) as any;
  const applied = new Set<string>(done.map((r: any) => r.name));
  const dir = [path.join(__dirname, '..', 'migrations'), path.join(__dirname, '..', '..', 'migrations')].find((d) => fs.existsSync(d))!;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f.endsWith('.optional.sql')) {
      // Optional steps (database triggers) need privileges some hosts withhold. Never leave the database half-migrated:
      // the file is idempotent, so a refused run is simply retried next time and the app keeps working meanwhile.
      try { await c.query(sql); } catch (e: any) {
        console.warn(`WARNING: optional migration ${f} was NOT applied: ${e.code ?? ''} ${e.sqlMessage ?? e.message}`);
        console.warn('         The app works, but the database does not yet enforce append-only history.');
        console.warn('         Ask the database admin to run  SET GLOBAL log_bin_trust_function_creators = 1;  (or grant SUPER), then run `npm run migrate` again.');
        continue;
      }
    } else {
      await c.query(sql);
    }
    await c.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
    console.log('applied', f);
  }
  await c.query('SELECT RELEASE_LOCK(?)', [lockName('aayme_migrate')]).catch(() => {});
  await c.end();
}

if (require.main === module) migrate().catch((e) => { console.error(e); process.exit(1); });
