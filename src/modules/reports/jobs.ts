import crypto from 'crypto';
import { exec, pool, q, q1 } from '../../db/pool';
import { storage } from '../../services/storage';
import { logger } from '../../utils/logger';
import { Row, toCsv, toXlsx } from '../../utils/tabular';
import { Range, parseRange } from './analytics';
import { MAX_REPORT_ROWS, reportByType } from './catalogue';

export interface JobParams { from?: string; to?: string; distributor_id?: number }

export const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export async function enqueueReport(userId: number, type: string, format: 'csv' | 'xlsx', params: JobParams): Promise<number> {
  const r = await exec(pool, "INSERT INTO report_jobs (requested_by, type, format, params) VALUES (?,?,?,?)", [userId, type, format, JSON.stringify(params)]);
  return r.insertId;
}

/**
 * Build one report file. Safe to call twice: only the call that moves the job from queued to running does the work, so two
 * workers (or a retry) can never produce two files or run an export twice.
 */
export async function runReportJob(id: number): Promise<'done' | 'failed' | 'skipped'> {
  const claimed = await exec(pool, "UPDATE report_jobs SET status = 'running', started_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'queued'", [id]);
  if (!claimed.affectedRows) return 'skipped';
  const job = (await q1<any>(pool, 'SELECT * FROM report_jobs WHERE id = ?', [id]))!;
  try {
    const def = reportByType(job.type);
    if (!def) throw new Error(`Unknown report type ${job.type}`);
    const p: JobParams = JSON.parse(job.params);
    const range: Range = parseRange({ from: p.from, to: p.to });
    let rows: Row[] = await def.rows(range, p.distributor_id);
    const truncated = rows.length > MAX_REPORT_ROWS;
    if (truncated) rows = rows.slice(0, MAX_REPORT_ROWS);

    const data = job.format === 'xlsx' ? toXlsx(def.title, def.columns, rows) : toCsv(def.columns, rows);
    const key = `report-${crypto.randomBytes(20).toString('hex')}.${job.format}`;
    await storage.put(key, data, MIME[job.format as 'csv' | 'xlsx']);
    const stamp = def.usesRange ? `${range.fromDate}_${range.toDate}` : new Date().toISOString().slice(0, 10);
    await exec(pool, "UPDATE report_jobs SET status = 'done', file_key = ?, file_name = ?, row_count = ?, truncated = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?", [
      key, `aayme-${job.type}-${stamp}.${job.format}`, rows.length, truncated ? 1 : 0, id,
    ]);
    return 'done';
  } catch (err: any) {
    logger.error({ err, jobId: id }, 'report job failed');
    await exec(pool, "UPDATE report_jobs SET status = 'failed', error = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?", [String(err?.message ?? err).slice(0, 300), id]);
    return 'failed';
  }
}

/** Pick up queued jobs (this process or a restart missed them) and fail jobs a crashed worker left "running". */
export async function sweepReportJobs(): Promise<number> {
  await exec(pool, "UPDATE report_jobs SET status = 'failed', error = 'Interrupted: the server restarted while building this report', finished_at = UTC_TIMESTAMP() WHERE status = 'running' AND started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)");
  const queued = await q<{ id: number }>(pool, "SELECT id FROM report_jobs WHERE status = 'queued' ORDER BY id LIMIT 5");
  for (const j of queued) await runReportJob(j.id);
  return queued.length;
}

let timer: NodeJS.Timeout | null = null;
export function startReportWorker(everyMs = 15_000) {
  if (timer) return;
  timer = setInterval(() => { sweepReportJobs().catch((err) => logger.error({ err }, 'report sweep failed')); }, everyMs);
  timer.unref();
}
