import { Router } from 'express';
import { z } from 'zod';
import { pool, q, q1 } from '../../db/pool';
import { storage } from '../../services/storage';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { computeAnalytics, KPI_DEFINITIONS, parseRange, rangeQuery } from './analytics';
import { REPORTS, reportByType } from './catalogue';
import { enqueueReport, MIME, runReportJob } from './jobs';

/**
 * Admin analytics and report exports. Mounted inside the admin router, so authentication, the admin role and the
 * two-factor requirement are already enforced by the time a request gets here.
 */
export const adminReportsRouter = Router();

adminReportsRouter.get('/kpi-definitions', (_req, res) => { res.json({ definitions: KPI_DEFINITIONS }); });

adminReportsRouter.get('/analytics', asyncHandler(async (req, res) => {
  const qs = rangeQuery.parse(req.query);
  res.json(await computeAnalytics(parseRange(qs), qs.distributor_id));
}));

adminReportsRouter.get('/reports/catalogue', (_req, res) => {
  res.json({ reports: REPORTS.map((r) => ({ type: r.type, title: r.title, description: r.description, uses_range: r.usesRange, columns: r.columns.map((c) => c.header) })) });
});

const present = (j: any) => ({
  id: j.id, type: j.type, format: j.format, status: j.status, params: JSON.parse(j.params), file_name: j.file_name, row_count: j.row_count,
  truncated: !!j.truncated, error: j.error, created_at: j.created_at, finished_at: j.finished_at,
});

adminReportsRouter.post('/reports', asyncHandler(async (req, res) => {
  const b = z.object({ type: z.string().max(40), format: z.enum(['csv', 'xlsx']).default('csv') }).and(rangeQuery).parse(req.body);
  const def = reportByType(b.type);
  if (!def) throw new AppError(400, 'UNKNOWN_REPORT', 'Unknown report type');
  parseRange(b);   // reject a bad range now, not minutes later inside the worker
  const me = req.auth!.userId;
  const open = await q1<any>(pool, "SELECT COUNT(*) n FROM report_jobs WHERE requested_by = ? AND status IN ('queued','running')", [me]);
  if (Number(open.n) >= 3) throw new AppError(429, 'TOO_MANY_REPORTS', 'You already have 3 reports being prepared. Wait for one to finish.');

  const id = await enqueueReport(me, def.type, b.format, { from: b.from, to: b.to, distributor_id: b.distributor_id });
  await audit(me, 'report.request', 'report', id, { type: def.type, format: b.format, from: b.from, to: b.to, distributor_id: b.distributor_id ?? null });
  // On a long-running server the worker picks the job up in the background. A serverless host may freeze the process the
  // moment the response is sent, so there the job is finished before answering.
  if (process.env.VERCEL) await runReportJob(id); else setImmediate(() => { runReportJob(id).catch(() => {}); });
  res.status(202).json(present((await q1<any>(pool, 'SELECT * FROM report_jobs WHERE id = ?', [id]))));
}));

adminReportsRouter.get('/reports', asyncHandler(async (req, res) => {
  const rows = await q<any>(pool, 'SELECT * FROM report_jobs WHERE requested_by = ? ORDER BY id DESC LIMIT 30', [req.auth!.userId]);
  res.json({ jobs: rows.map(present) });
}));

adminReportsRouter.get('/reports/:id', asyncHandler(async (req, res) => {
  const j = await q1<any>(pool, 'SELECT * FROM report_jobs WHERE id = ? AND requested_by = ?', [idParam(req), req.auth!.userId]);
  if (!j) throw new AppError(404, 'NOT_FOUND', 'Report not found');
  res.json(present(j));
}));

// A report is private to whoever asked for it.
adminReportsRouter.get('/reports/:id/download', asyncHandler(async (req, res) => {
  const j = await q1<any>(pool, 'SELECT * FROM report_jobs WHERE id = ? AND requested_by = ?', [idParam(req), req.auth!.userId]);
  if (!j) throw new AppError(404, 'NOT_FOUND', 'Report not found');
  if (j.status !== 'done' || !j.file_key) throw new AppError(409, 'NOT_READY', j.status === 'failed' ? 'This report failed to build' : 'This report is still being prepared');
  const data = await storage.read(j.file_key);
  if (!data) throw new AppError(410, 'GONE', 'The file is no longer available. Request the report again.');
  await audit(req.auth!.userId, 'report.download', 'report', j.id, { type: j.type });
  res.setHeader('Content-Type', MIME[j.format as 'csv' | 'xlsx']);
  res.setHeader('Content-Disposition', `attachment; filename="${String(j.file_name).replace(/[^\w.\-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(data);
}));
