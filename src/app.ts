import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from './config/env';
import { authRouter } from './modules/auth/auth.routes';
import { accountRouter } from './modules/account/account.routes';
import { invoiceRouter } from './modules/invoices/invoices.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { chatRouter } from './modules/chat/chat.routes';
import { deviceRouter } from './modules/devices/devices.routes';
import { docsRouter } from './modules/docs/docs.routes';
import { paymentRouter } from './modules/payments/payments.routes';
import { paymentWebhookRouter } from './modules/payments/payments.webhook';
import { complianceRouter } from './modules/compliance/compliance.routes';
import { announcementRouter } from './modules/announcements/announcements.routes';
import { subscriptionRouter } from './modules/subscription/subscription.routes';
import { mediaRouter } from './modules/media/media.routes';
import { collectionsRouter } from './modules/collections/collections.routes';
import { returnsRouter } from './modules/returns/returns.routes';
import { catalogRouter } from './modules/catalog/catalog.routes';
import { distributorRouter } from './modules/distributors/distributors.routes';
import { ledgerRouter } from './modules/ledger/ledger.routes';
import { orderRouter } from './modules/orders/orders.routes';
import { retailerRouter } from './modules/retailers/retailers.routes';
import { errorHandler } from './utils/errors';
import { logger } from './utils/logger';
import { pool } from './db/pool';
import { metricsHandler, metricsMiddleware } from './utils/metrics';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(compression());
  app.use(metricsMiddleware);
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
  app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
  // catalog imports send up to 500 rows. The payment webhook also keeps the exact bytes: its signature covers them.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { if ((req as any).originalUrl.startsWith('/api/v1/payments/webhook')) (req as any).rawBody = buf; } }));
  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? crypto.randomUUID();
    res.setHeader('x-request-id', id);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/health' || req.path === '/ready') return;
      logger.info({ reqId: id, method: req.method, url: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - started, userId: req.auth?.userId }, 'request');
    });
    next();
  });

  if (!env.isTest) app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 300), standardHeaders: true, legacyHeaders: false }));
  app.get('/metrics', metricsHandler(env.isProd));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  // Readiness: only report ready when the database answers (used by load balancers / orchestrators).
  // `ledger_immutable` tells operators whether the database itself blocks edits to ledger history.
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const [rows] = await pool.query<any[]>("SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name LIKE 'trg\\_%\\_no\\_%'");
      res.json({ ready: true, ledger_immutable: Number(rows[0].n) >= 8 });
    } catch { res.status(503).json({ ready: false }); }
  });

  // Brute-force protection on credential endpoints (skipped under test).
  if (!env.isTest) {
    // Only FAILED requests count, so a shop full of staff behind one IP is not locked out by their own successful logins.
    app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60_000, limit: 100, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false }));
    // Emailing codes costs money and can be abused to spam people: cap it per IP across all identifiers.
    app.use('/api/v1/auth/otp/request', rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));
    app.use('/api/v1/auth/register', rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
  }

  // Web admin console (static files; the API enforces who may do what).
  const publicDir = [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', '..', 'public')].find((d) => fs.existsSync(d));
  if (publicDir) app.use('/admin-console', express.static(path.join(publicDir, 'admin'), { maxAge: env.isProd ? '1h' : 0 }));

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/distributor', distributorRouter);
  app.use('/api/v1/catalog', catalogRouter);
  app.use('/api/v1/retailer', retailerRouter);
  app.use('/api/v1', invoiceRouter); // before orderRouter: /orders/:id/invoice is reachable via a signed link
  app.use('/api/v1/orders', orderRouter);
  app.use('/api/v1/me', accountRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/ledger', ledgerRouter);
  app.use('/api/v1/payments/webhook', paymentWebhookRouter); // before paymentRouter: no login, signature instead
  app.use('/api/v1/payments', paymentRouter);
  app.use('/api/v1/media', mediaRouter);
  app.use('/api/v1/subscription', subscriptionRouter);
  app.use('/api/v1/announcements', announcementRouter);
  app.use('/api/v1/compliance', complianceRouter);
  app.use('/api/v1/returns', returnsRouter);
  app.use('/api/v1/collections', collectionsRouter);
  app.use('/api/v1/chat', chatRouter);
  app.use('/api/v1/devices', deviceRouter);
  app.use('/api/v1/admin', adminRouter);
  if (!env.isProd || process.env.ENABLE_DOCS === '1') app.use(docsRouter); // API docs are not published by default in production

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
