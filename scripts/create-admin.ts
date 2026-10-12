import bcrypt from 'bcryptjs';
import { exec, pool } from '../src/db/pool';

// usage: npm run create-admin -- <phone> <password> [name]
(async () => {
  const [phone, password, name = 'Platform Admin'] = process.argv.slice(2);
  if (!/^\d{10}$/.test(phone ?? '') || !password || password.length < 8) {
    console.error('usage: create-admin <10-digit phone> <password min 8> [name]');
    process.exit(1);
  }
  await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [phone, name, await bcrypt.hash(password, 10)]);
  console.log('admin created');
  await pool.end();
})();
