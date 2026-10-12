// Vercel serverless entry: reuses the Express app from src/app.ts.
// Not run here: migrations, Socket.io chat, cron jobs (they need a long-running server).
// Run `npm run migrate` against the production DB by hand instead.
import { createApp } from '../src/app';

export default createApp();
