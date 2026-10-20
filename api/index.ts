// Vercel serverless entry: reuses the Express app from src/app.ts.
// Not run here: Socket.io chat and cron jobs (they need a long-running server).
// Database migrations: a serverless function has no "start-up" step, so the first request after a cold start applies any
// migration that has not run yet (additive SQL files in /migrations, guarded by a database lock). Failures are logged and the
// app keeps serving. Set AUTO_MIGRATE=0 to switch this off and run `npm run migrate` by hand instead.
import type { Request, Response } from 'express';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';

const app = createApp();
let schemaReady: Promise<void> | undefined;

const ensureSchema = () => (schemaReady ??= process.env.AUTO_MIGRATE === '0'
  ? Promise.resolve()
  : migrate().catch((err: any) => { console.error('[migrate] could not apply pending migrations:', err?.code ?? '', err?.sqlMessage ?? err?.message ?? err); }));

export default async function handler(req: Request, res: Response) {
  await ensureSchema();
  return app(req, res);
}
