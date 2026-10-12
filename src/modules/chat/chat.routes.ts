import { Router } from 'express';
import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { AuthCtx, authenticate, isUserActive, verifyAccessToken } from '../../middleware/auth';
import { AppError, asyncHandler } from '../../utils/errors';
import { conversations, history, markRead, peerLastRead, resolvePair, sendMessage, setBroadcaster, setReadBroadcaster } from './chat.service';

export const chatRouter = Router();
chatRouter.use(authenticate);

chatRouter.get('/conversations', asyncHandler(async (req, res) => {
  const pg = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const rows = await conversations(req.auth!, pg.limit, pg.offset);
  res.json({ conversations: rows.map((r) => ({ ...r, unread: Number(r.unread) })), limit: pg.limit, offset: pg.offset });
}));

const pairQuery = z.object({ distributor_id: z.coerce.number().int().optional(), retailer_id: z.coerce.number().int().optional() });

chatRouter.get('/messages', asyncHandler(async (req, res) => {
  const qs = pairQuery.extend({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  const pair = await resolvePair(req.auth!, qs.distributor_id, qs.retailer_id);
  const messages = await history(pair, qs.before, qs.limit);
  if (messages.length) await markRead(req.auth!.userId, pair, messages[messages.length - 1].id);
  // peer_last_read_id: messages with id <= this have been seen by the other side (the app shows double ticks)
  res.json({ messages, peer_last_read_id: await peerLastRead(req.auth!, pair) });
}));

// REST send (used for offline outbox replay). client_id makes retries idempotent.
chatRouter.post('/messages', asyncHandler(async (req, res) => {
  const b = pairQuery.extend({ body: z.string(), client_id: z.string().max(60).optional() }).parse(req.body);
  const pair = await resolvePair(req.auth!, b.distributor_id, b.retailer_id);
  const { message, replayed } = await sendMessage(req.auth!, pair, b.body, b.client_id);
  res.status(replayed ? 200 : 201).json({ replayed, message });
}));

const SEND_LIMIT = 20;
const SEND_WINDOW_MS = 10_000;
const MAX_SOCKET_MS = 60 * 60_000; // never stay connected longer than an hour without re-authenticating

/** Real-time layer. Rooms: `d:<distributorId>` for the whole team, `r:<retailerId>` for the retailer. */
export async function attachSocket(http: HttpServer) {
  const io = new Server(http, { cors: { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*' } });

  // With several API servers, set REDIS_URL so messages reach sockets connected to any server.
  if (process.env.REDIS_URL) {
    const { createClient } = await import('redis');
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const pub = createClient({ url: process.env.REDIS_URL });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
  }

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined) ?? '';
      const claims = verifyAccessToken(token);
      if (!(await isUserActive(claims.userId))) return next(new Error('unauthorized'));
      socket.data.auth = { userId: claims.userId, role: claims.role, distributorId: claims.distributorId } as AuthCtx;
      socket.data.exp = claims.exp;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const a = socket.data.auth as AuthCtx;
    if (a.role === 'retailer') socket.join(`r:${a.userId}`);
    else if (a.distributorId) socket.join(`d:${a.distributorId}`);

    // The login token that opened this connection has a lifetime: when it ends so does the connection, and the
    // app reconnects with a fresh token. A closed or stolen session therefore cannot stay connected forever.
    const msLeft = socket.data.exp ? socket.data.exp * 1000 - Date.now() : MAX_SOCKET_MS;
    const killer = setTimeout(() => socket.disconnect(true), Math.max(1000, Math.min(msLeft, MAX_SOCKET_MS)));
    socket.on('disconnect', () => clearTimeout(killer));

    // Flood control: at most SEND_LIMIT messages per SEND_WINDOW_MS per connection.
    let sent: number[] = [];
    // Authorization happens on every send: the room only delivers, it never grants posting rights.
    socket.on('message:send', async (p: { distributor_id?: number; retailer_id?: number; body: string; client_id?: string }, ack?: (r: unknown) => void) => {
      try {
        const now = Date.now();
        sent = sent.filter((t) => now - t < SEND_WINDOW_MS);
        if (sent.length >= SEND_LIMIT) throw new AppError(429, 'RATE_LIMIT', 'You are sending messages too fast');
        sent.push(now);
        if (!(await isUserActive(a.userId))) { socket.disconnect(true); return; }
        const pair = await resolvePair(a, p?.distributor_id, p?.retailer_id);
        const { message } = await sendMessage(a, pair, String(p?.body ?? ''), p?.client_id);
        ack?.({ ok: true, message });
      } catch (e: any) {
        ack?.({ ok: false, error: { code: e.code ?? 'ERROR', message: e.message } });
      }
    });
  });

  setReadBroadcaster((e) => io.to(`d:${e.distributor_id}`).to(`r:${e.retailer_id}`).emit('message:read', e));
  setBroadcaster((m) => io.to(`d:${m.distributor_id}`).to(`r:${m.retailer_id}`).emit('message:new', m));
  return io;
}
