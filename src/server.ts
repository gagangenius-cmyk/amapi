import { createServer } from 'http';
import { migrate } from '../scripts/migrate';
import { createApp } from './app';
import { env } from './config/env';
import { pool } from './db/pool';
import { startJobs } from './jobs/subscriptionWarnings';
import { attachSocket } from './modules/chat/chat.routes';
import { logger } from './utils/logger';

const http = createServer(createApp());

async function start() {
  // The schema updates itself: pending migrations are applied before the first request is served (set AUTO_MIGRATE=0 to manage it by hand).
  if (process.env.AUTO_MIGRATE !== '0') await migrate();
  await attachSocket(http).catch((e) => logger.error({ err: e }, 'socket setup failed'));
  http.listen(env.port, () => {
    logger.info({ port: env.port }, 'AAYME API listening');
    startJobs();
    pool.query<any[]>("SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name LIKE 'trg\\_%\\_no\\_%'")
      .then(([rows]) => { if (Number(rows[0].n) < 8) logger.warn('Database does not enforce append-only ledger history (triggers missing). See DEPLOYMENT.md.'); })
      .catch(() => {});
  });
}
start().catch((err) => { logger.fatal({ err }, 'startup failed (migration or database problem)'); process.exit(1); });

// Finish in-flight requests, then close the DB pool, so deploys don't drop requests.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  http.close(async () => { await pool.end().catch(() => {}); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandledRejection'));
