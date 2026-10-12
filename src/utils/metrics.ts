import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { pool } from '../db/pool';

/** Prometheus metrics. The route PATTERN is the label (e.g. /orders/:id), so ids never explode the number of series. */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'API latency', labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});
new client.Gauge({
  name: 'db_pool_connections', help: 'MySQL pool connections by state', labelNames: ['state'] as const, registers: [registry],
  collect() {
    const p = (pool as any).pool;
    this.set({ state: 'total' }, p._allConnections?.length ?? 0);
    this.set({ state: 'free' }, p._freeConnections?.length ?? 0);
    this.set({ state: 'waiting' }, p._connectionQueue?.length ?? 0);
  },
});
export const businessEvents = new client.Counter({ name: 'business_events_total', help: 'Domain events', labelNames: ['event'] as const, registers: [registry] });

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

/** In production the endpoint exists only when METRICS_TOKEN is set, and then requires it. */
export function metricsHandler(isProd: boolean) {
  const token = process.env.METRICS_TOKEN;
  return async (req: Request, res: Response) => {
    if (token) {
      const got = Buffer.from(req.header('authorization')?.replace(/^Bearer /, '') ?? '');
      const want = Buffer.from(token);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return void res.status(401).end();
    } else if (isProd) return void res.status(404).end();
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  };
}
