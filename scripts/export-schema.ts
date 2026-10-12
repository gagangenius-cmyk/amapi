import fs from 'fs';
import path from 'path';

// Prints the complete current schema (all migrations in order) so it can be pasted into phpMyAdmin/MySQL.
// Usage: npm run schema:export > schema.sql
const dir = path.join(__dirname, '..', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const out: string[] = ['-- AAYME full schema (generated from migrations; do not edit)', 'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);'];
for (const f of files) out.push(`\n-- ${f}`, fs.readFileSync(path.join(dir, f), 'utf8'));
out.push(`INSERT INTO schema_migrations (name) VALUES ${files.map((f) => `('${f}')`).join(', ')};`);
process.stdout.write(out.join('\n') + '\n');
