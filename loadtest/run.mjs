// Load test. Start the API against a THROWAWAY database first, e.g.:
//   DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD= DB_NAME=aymee_load RATE_LIMIT_PER_MIN=1000000 PORT=4100 npx tsx src/server.ts
// then: node loadtest/run.mjs http://localhost:4100
import autocannon from 'autocannon';

const BASE = process.argv[2] ?? 'http://localhost:4100';
const API = BASE + '/api/v1';
const rnd = String(Math.floor(Math.random() * 9e7) + 1e7);
const call = async (path, { method = 'GET', body, token, key } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...(key && { 'Idempotency-Key': key }) }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(path + ' ' + JSON.stringify(j)); return j;
};

const d = await call('/auth/register', { method: 'POST', body: { role: 'distributor', phone: '9' + rnd + '1', email: `ld${rnd}@load.test`, name: 'Load Dist', password: 'password123', business_name: 'Load Dist' } });
const r = await call('/auth/register', { method: 'POST', body: { role: 'retailer', phone: '9' + rnd + '2', email: `lr${rnd}@load.test`, name: 'Load Ret', password: 'password123', shop_name: 'Load Shop', pincode: '400001' } });
await call('/retailer/primary', { method: 'PUT', token: r.access_token, body: { distributor_id: d.id } });
const pid = (await call('/catalog', { method: 'POST', token: d.access_token, body: { name: 'Load item', price: '10', stock_qty: 1000000 } })).id;

const run = (title, opts) => new Promise((res) => {
  const inst = autocannon({ url: BASE, connections: 40, duration: Number(process.env.LOAD_SECONDS ?? 10), ...opts }, (err, out) => {
    if (err) throw err;
    const non2xx = out.non2xx ?? 0;
    console.log(`${title.padEnd(34)} ${String(Math.round(out.requests.average)).padStart(6)} req/s  p50 ${out.latency.p50}ms  p99 ${out.latency.p99}ms  errors ${out.errors}  non-2xx ${non2xx} ${non2xx ? JSON.stringify(Object.fromEntries(Object.entries(out.statusCodeStats).map(([c, v]) => [c, v.count]))) : ""}`);
    res(out);
  });
  autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
});

let n = 0;
console.log(`Target ${BASE}, 40 connections x 10 s per scenario\n`);
await run('GET /retailer/stores (read)', { requests: [{ method: 'GET', path: '/api/v1/retailer/stores', headers: { Authorization: `Bearer ${r.access_token}` } }] });
await run('POST /orders (write, unique keys)', {
  requests: [{ method: 'POST', path: '/api/v1/orders', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${r.access_token}` },
    setupRequest: (req) => ({ ...req, headers: { ...req.headers, 'Idempotency-Key': `ld-${rnd}-${++n}` }, body: JSON.stringify({ distributor_id: d.id, items: [{ product_id: pid, qty: 1 }] }) }) }],
});
await run('POST /ledger (same pair, contention)', {
  requests: [{ method: 'POST', path: '/api/v1/ledger/transaction', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.access_token}` },
    setupRequest: (req) => ({ ...req, headers: { ...req.headers, 'Idempotency-Key': `lg-${rnd}-${++n}` }, body: JSON.stringify({ retailer_id: r.id, transaction_type: 'debit_note', amount: '1.00' }) }) }],
});

// Integrity check straight from the database once the server has drained its queue.
await new Promise((res) => setTimeout(res, 5000));
import('mysql2/promise').then(async ({ default: mysql }) => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', database: process.env.DB_NAME ?? 'aymee_load' });
  const [[rel]] = await c.query('SELECT balance_due_paise b FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ?', [r.id, d.id]);
  const [rows] = await c.query('SELECT delta_paise, balance_after_paise FROM ledger_transactions WHERE retailer_id = ? AND distributor_id = ? ORDER BY id', [r.id, d.id]);
  let run = 0, brokenAt = -1;
  rows.forEach((x, k) => { run += Number(x.delta_paise); if (run !== Number(x.balance_after_paise) && brokenAt < 0) brokenAt = k; });
  console.log(`
Ledger rows: ${rows.length}; balance ${rel.b} paise; sum of deltas ${run} paise`);
  console.log(Number(rel.b) === run && brokenAt < 0 ? 'PASS balance == sum of entries and every balance_after chains exactly' : `FAIL ledger inconsistent (first break at row ${brokenAt})`);
  const [[o]] = await c.query("SELECT COUNT(*) n FROM orders WHERE retailer_id = ?", [r.id]);
  const [[dup]] = await c.query('SELECT COUNT(*) n FROM (SELECT idempotency_key FROM orders WHERE retailer_id = ? GROUP BY idempotency_key HAVING COUNT(*) > 1) t', [r.id]);
  console.log(`Orders created: ${o.n}; duplicate idempotency keys: ${dup.n}`);
  await c.end();
});
