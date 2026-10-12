import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.isTest ? 'silent' : process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['req.headers.authorization', 'password', '*.password', 'refresh_token', '*.refresh_token', 'code', 'new_password'], censor: '[redacted]' },
  base: { svc: 'aayme-api' },
});
