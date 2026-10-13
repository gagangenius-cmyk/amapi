import { Request, Router } from 'express';
import { z } from 'zod';
import { pool, q, q1 } from '../../db/pool';
import { storage } from '../../services/storage';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, forbidden } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { computeAnalytics, KPI_DEFINITIONS, parseRange, rangeQuery } from './analytics';
import { REPORTS, reportByType } from './catalogue';
import { enqueueReport, MIME, runReportJob } from './jobs';

/**
 * Analytics and exports. The same handlers serve the admin (the whole platform) and a company employee (only the distributors
 * mapped to them): `scopeOf` says which distributors the caller may see, and every query is filtered by it on the server.
 * Authentication, the role and two-factor are applied by whoever mounts the router.
 */
export type ScopeOf = (req: Request) => Promise<number[] | null>;

const present = (j: any) => ({
  id: j.id, type: j.type, format: j.format, status: j.status, params: JSON.parse(j.params), file_name: j.file_name, row_count: j.row_count,
  truncated: !!j.truncated, error: j.error, created_at: j.created_at, finished_at: j.finished_at,
});

export function makeReportsRouter(scopeOf: ScopeOf): Router {
  const router = Router();

  /** The distributors a request may cover: everything the caller is allowed (or one of them, when asked for). null = no limit. */
  async function resolveScope(req: Request, requested?: number): Promise<number[] | undefined> {
    const allowed = await scopeOf(req);
    if (allowed === null) return requested ? [requested] : undefined;
    if (requested) {
      if (!allowed.includes(requested)) throw forbidden('That distributor is not one of yours');
      return [requested];
    }
    return allowed.length ? allowed : [0];       // no distributors yet: a scope that matches nothing, so every figure is zero
  }

  router.get('/kpi-definitions', (_req, res) => { res.json({ definitions: KPI_DEFINITIONS }); });

  router.get('/analytics', asyncHandler(async (req, res) => {
    const qs = rangeQuery.parse(req.query);
    res.json(await computeAnalytics(parseRange(qs), await resolveScope(req, qs.distributor_id)));
  }));

  router.get('/reports/catalogue', (_req, res) => {
    res.json({ reports: REPORTS.map((r) => ({ type: r.type, title: r.title, description: r.description, uses_range: r.usesRange, columns: r.columns.map((c) => c.header) })) });
  });

  router.post('/reports', asyncHandler(async (req, res) => {
    const b = z.object({ type: z.string().max(40), format: z.enum(['csv', 'xlsx']).default('csv') }).and(rangeQuery).parse(req.body);
    const def = reportByType(b.type);
    if (!def) throw new AppError(400, 'UNKNOWN_REPORT', 'Unknown report type');
    parseRange(b);   // reject a bad range now, not minutes later inside the worker
    const me = req.auth!.userId;
    const ids = await resolveScope(req, b.distributor_id);
    const open = await q1<any>(pool, "SELECT COUNT(*) n FROM report_jobs WHERE requested_by = ? AND status IN ('queued','running')", [me]);
    if (Number(open.n) >= 3) throw new AppError(429, 'TOO_MANY_REPORTS', 'You already have 3 reports being prepared. Wait for one to finish.');

    const id = await enqueueReport(me, def.type, b.format, { from: b.from, to: b.to, distributor_ids: ids });
    await audit(me, 'report.request', 'report', id, { type: def.type, format: b.format, from: b.from, to: b.to, distributors: ids ? ids.length : 'all' });
    // On a long-running server the worker picks the job up in the background. A serverless host may freeze the process the
    // moment the response is sent, so there the job is finished before answering.
    if (process.env.VERCEL) await runReportJob(id); else setImmediate(() => { runReportJob(id).catch(() => {}); });
    res.status(202).json(present((await q1<any>(pool, 'SELECT * FROM report_jobs WHERE id = ?', [id]))));
  }));

  router.get('/reports', asyncHandler(async (req, res) => {
    const rows = await q<any>(pool, 'SELECT * FROM report_jobs WHERE requested_by = ? ORDER BY id DESC LIMIT 30', [req.auth!.userId]);
    res.json({ jobs: rows.map(present) });
  }));

  router.get('/reports/:id', asyncHandler(async (req, res) => {
    const j = await q1<any>(pool, 'SELECT * FROM report_jobs WHERE id = ? AND requested_by = ?', [idParam(req), req.auth!.userId]);
    if (!j) throw new AppError(404, 'NOT_FOUND', 'Report not found');
    res.json(present(j));
  }));

  // A report is private to whoever asked for it.
  router.get('/reports/:id/download', asyncHandler(async (req, res) => {
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

  return router;
}

/** The admin sees the whole platform. */
export const adminReportsRouter = makeReportsRouter(async () => null);
