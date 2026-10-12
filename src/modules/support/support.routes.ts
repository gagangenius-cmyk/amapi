import crypto from 'crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole, requireTwoFactor } from '../../middleware/auth';
import { sniffImage, storage } from '../../services/storage';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, forbidden, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { loadStaffPermissions } from '../staff/permissions';
import {
  addMessage, badState, canMove, CUSTOMER_PRIORITIES, deskAgents, minutesAfter, PRIORITIES, Priority, REOPEN_DAYS, slaFor, slaState, sqlTime, Status,
} from './support.service';

const MAX_OPEN_PER_USER = 20;
const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

const present = (t: any) => ({
  id: t.id, subject: t.subject, status: t.status as Status, priority: t.priority as Priority, category_id: t.category_id, category: t.category ?? undefined,
  requester_id: t.requester_id, requester: t.requester_name ?? undefined, requester_role: t.requester_role, order_id: t.order_id,
  assignee_id: t.assignee_id, assignee: t.assignee_name ?? null,
  created_at: t.created_at, last_activity_at: t.last_activity_at, first_response_at: t.first_response_at, first_response_due: t.first_response_due,
  resolution_due: t.resolution_due, resolved_at: t.resolved_at, closed_at: t.closed_at, resolution_note: t.resolution_note,
  sla: slaState(t), escalation_level: t.escalation_level, rating: t.rating ?? null,
});

const TICKET_SQL = `SELECT t.*, c.name category, COALESCE(rp.shop_name, dp.business_name, u.name) requester_name, a.name assignee_name
  FROM support_tickets t JOIN support_categories c ON c.id = t.category_id JOIN users u ON u.id = t.requester_id
  LEFT JOIN retailer_profiles rp ON rp.user_id = t.requester_id LEFT JOIN distributor_profiles dp ON dp.user_id = t.requester_id
  LEFT JOIN users a ON a.id = t.assignee_id`;

async function thread(ticketId: number, forStaff: boolean) {
  const rows = await q<any>(pool, `SELECT m.id, m.author_id, m.author_side, m.kind, m.body, m.created_at, u.name author FROM support_messages m
    LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = ? ${forStaff ? '' : "AND m.kind <> 'internal'"} ORDER BY m.id`, [ticketId]);
  const files = await q<any>(pool, 'SELECT id, file_name, mime, size_bytes, uploaded_by, created_at FROM support_attachments WHERE ticket_id = ? ORDER BY id', [ticketId]);
  return {
    messages: rows.map((m) => ({ id: m.id, side: m.author_side, kind: m.kind, body: m.body, author: m.author_side === 'system' ? 'System' : m.author ?? null, at: m.created_at })),
    attachments: files.map((f) => ({ id: f.id, name: f.file_name, mime: f.mime, size: f.size_bytes, at: f.created_at })),
  };
}

const ownTicket = async (id: number, userId: number) => {
  const t = await q1<any>(pool, `${TICKET_SQL} WHERE t.id = ? AND t.requester_id = ?`, [id, userId]);
  if (!t) throw notFound('Ticket');       // someone else's ticket looks like a missing one
  return t;
};
const anyTicket = async (id: number) => {
  const t = await q1<any>(pool, `${TICKET_SQL} WHERE t.id = ?`, [id]);
  if (!t) throw notFound('Ticket');
  return t;
};

const bodyText = z.string().trim().min(1).max(4000);

// =============================================================================================
// Staff desk
// =============================================================================================
async function deskGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.auth!.role === 'admin') return next();
    const p = await loadStaffPermissions(req.auth!.userId);
    if (!p.actions.includes('handle_support')) return next(forbidden('The admin has not given you the support desk'));
    next();
  } catch (e) { next(e); }
}
async function reportsGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.auth!.role === 'admin') return next();
    const p = await loadStaffPermissions(req.auth!.userId);
    if (!p.actions.includes('support_reports')) return next(forbidden('The admin has not given you support reports'));
    next();
  } catch (e) { next(e); }
}

export const deskRouter = Router();
deskRouter.use(authenticate, requireRole('admin', 'company_employee'), requireTwoFactor, deskGuard);

deskRouter.get('/agents', asyncHandler(async (_req, res) => { res.json({ agents: await deskAgents() }); }));

deskRouter.get('/tickets', asyncHandler(async (req, res) => {
  const qs = z.object({
    status: z.enum(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed', 'active', 'all']).default('active'),
    priority: z.enum(PRIORITIES).optional(), category_id: z.coerce.number().int().positive().optional(),
    assignee: z.string().regex(/^(me|none|\d+)$/).optional(), overdue: z.enum(['0', '1']).default('0'),
    q: z.string().trim().max(80).optional(), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  }).parse(req.query);
  const where = ['1=1']; const args: unknown[] = [];
  if (qs.status === 'active') where.push("t.status IN ('open','in_progress','waiting_customer')");
  else if (qs.status !== 'all') { where.push('t.status = ?'); args.push(qs.status); }
  if (qs.priority) { where.push('t.priority = ?'); args.push(qs.priority); }
  if (qs.category_id) { where.push('t.category_id = ?'); args.push(qs.category_id); }
  if (qs.assignee === 'me') { where.push('t.assignee_id = ?'); args.push(req.auth!.userId); }
  else if (qs.assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (qs.assignee) { where.push('t.assignee_id = ?'); args.push(Number(qs.assignee)); }
  if (qs.overdue === '1') {
    where.push("t.status IN ('open','in_progress') AND ((t.first_response_at IS NULL AND t.first_response_due < UTC_TIMESTAMP()) OR t.resolution_due < UTC_TIMESTAMP())");
  }
  if (qs.q) { where.push('(t.subject LIKE ? OR t.id = ? OR rp.shop_name LIKE ? OR dp.business_name LIKE ?)'); const l = `%${qs.q}%`; args.push(l, Number(qs.q) || 0, l, l); }
  if (qs.before) { where.push('t.id < ?'); args.push(qs.before); }
  // most urgent first among the unfinished, then newest
  const rows = await q<any>(pool, `${TICKET_SQL} WHERE ${where.join(' AND ')}
    ORDER BY FIELD(t.priority,'urgent','high','normal','low'), t.escalation_level DESC, t.id DESC LIMIT ?`, [...args, qs.limit]);
  res.json({ tickets: rows.map(present) });
}));

deskRouter.get('/tickets/:id', asyncHandler(async (req, res) => {
  const t = await anyTicket(idParam(req));
  res.json({ ticket: present(t), ...(await thread(t.id, true)) });
}));

deskRouter.post('/tickets/:id/messages', asyncHandler(async (req, res) => {
  const b = z.object({ body: bodyText, internal: z.boolean().default(false), wait_for_customer: z.boolean().default(false) }).parse(req.body);
  const me = req.auth!.userId; const id = idParam(req);
  const t = await anyTicket(id);
  if (t.status === 'closed') throw new AppError(409, 'CLOSED', 'This ticket is closed');
  await withTx(async (c) => {
    await addMessage(c, { ticketId: id, authorId: me, side: 'staff', kind: b.internal ? 'internal' : 'reply', body: b.body });
    if (b.internal) return;
    // the first reply the customer can read is the "first response" the SLA measures
    await exec(c, "UPDATE support_tickets SET first_response_at = COALESCE(first_response_at, UTC_TIMESTAMP()), assignee_id = COALESCE(assignee_id, ?) WHERE id = ?", [me, id]);
    const next: Status = b.wait_for_customer ? 'waiting_customer' : t.status === 'open' || t.status === 'waiting_customer' ? 'in_progress' : (t.status as Status);
    if (t.status !== 'resolved' && next !== t.status) await exec(c, 'UPDATE support_tickets SET status = ? WHERE id = ?', [next, id]);
  });
  if (!b.internal) notifyUsers([t.requester_id], `Support ticket #${id}`, b.body.slice(0, 120), { type: 'support', id });
  res.status(201).json({ ok: true });
}));

deskRouter.post('/tickets/:id/assign', asyncHandler(async (req, res) => {
  const { assignee_id } = z.object({ assignee_id: z.number().int().positive().nullable() }).parse(req.body);
  const me = req.auth!.userId; const id = idParam(req);
  const t = await anyTicket(id);
  if (t.status === 'closed') throw new AppError(409, 'CLOSED', 'This ticket is closed');
  // staff take tickets for themselves or put them back; handing one to a colleague is for the admin
  if (assignee_id !== null && assignee_id !== me && req.auth!.role !== 'admin') throw forbidden('Only the admin can assign a ticket to someone else');
  if (assignee_id !== null && !(await deskAgents()).some((a) => a.id === assignee_id)) throw new AppError(400, 'NOT_AN_AGENT', 'That person does not handle support');
  await exec(pool, "UPDATE support_tickets SET assignee_id = ?, status = IF(status = 'open' AND ? IS NOT NULL, 'in_progress', status) WHERE id = ?", [assignee_id, assignee_id, id]);
  await addMessage(pool, { ticketId: id, authorId: me, side: 'system', kind: 'internal', body: assignee_id ? (assignee_id === me ? 'Taken by the agent' : `Assigned to user ${assignee_id}`) : 'Returned to the queue' });
  if (assignee_id && assignee_id !== me) notifyUsers([assignee_id], `Support ticket #${id} assigned to you`, t.subject, { type: 'support', id });
  await audit(me, 'support.assign', 'support_ticket', id, { assignee_id });
  res.json({ id, assignee_id });
}));

deskRouter.put('/tickets/:id', asyncHandler(async (req, res) => {
  const b = z.object({
    priority: z.enum(PRIORITIES).optional(), category_id: z.number().int().positive().optional(),
    status: z.enum(['open', 'in_progress', 'waiting_customer']).optional(),
  }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const me = req.auth!.userId; const id = idParam(req);
  const t = await anyTicket(id);
  if (t.status === 'closed' || t.status === 'resolved') throw new AppError(409, 'BAD_STATE', 'Reopen the ticket before changing it');
  if (b.status && !canMove(t.status, b.status)) throw badState(t.status, b.status);
  if (b.category_id && !(await q1(pool, 'SELECT 1 FROM support_categories WHERE id = ? AND is_active = 1', [b.category_id]))) throw new AppError(400, 'BAD_CATEGORY', 'Unknown category');
  await withTx(async (c) => {
    if (b.priority && b.priority !== t.priority) {
      // new targets, counted from when the ticket was raised
      const sla = await slaFor(c, b.priority);
      await exec(c, 'UPDATE support_tickets SET priority = ?, first_response_due = ?, resolution_due = ? WHERE id = ?', [b.priority, sqlTime(minutesAfter(t.created_at, sla.first)), sqlTime(minutesAfter(t.created_at, sla.resolve)), id]);
      await addMessage(c, { ticketId: id, authorId: me, side: 'system', kind: 'internal', body: `Priority ${t.priority} to ${b.priority}` });
    }
    if (b.category_id) await exec(c, 'UPDATE support_tickets SET category_id = ? WHERE id = ?', [b.category_id, id]);
    if (b.status && b.status !== t.status) await exec(c, 'UPDATE support_tickets SET status = ? WHERE id = ?', [b.status, id]);
  });
  await audit(me, 'support.update', 'support_ticket', id, b);
  res.json({ ticket: present(await anyTicket(id)) });
}));

deskRouter.post('/tickets/:id/resolve', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body);
  const me = req.auth!.userId; const id = idParam(req);
  const t = await anyTicket(id);
  if (!canMove(t.status, 'resolved') || t.status === 'resolved') throw badState(t.status, 'resolved');
  await withTx(async (c) => {
    await exec(c, "UPDATE support_tickets SET status = 'resolved', resolved_at = UTC_TIMESTAMP(), resolution_note = ?, first_response_at = COALESCE(first_response_at, UTC_TIMESTAMP()) WHERE id = ?", [note, id]);
    await addMessage(c, { ticketId: id, authorId: me, side: 'staff', kind: 'reply', body: `Resolved: ${note}` });
  });
  notifyUsers([t.requester_id], `Support ticket #${id} resolved`, note.slice(0, 120), { type: 'support', id });
  await audit(me, 'support.resolve', 'support_ticket', id);
  res.json({ id, status: 'resolved' });
}));

deskRouter.post('/tickets/:id/reopen', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const t = await anyTicket(id);
  if (t.status !== 'resolved' && t.status !== 'closed') throw badState(t.status, 'in_progress');
  await exec(pool, "UPDATE support_tickets SET status = 'in_progress', resolved_at = NULL, closed_at = NULL WHERE id = ?", [id]);
  await addMessage(pool, { ticketId: id, authorId: req.auth!.userId, side: 'system', kind: 'internal', body: 'Reopened by staff' });
  res.json({ id, status: 'in_progress' });
}));

// ---- performance ----
deskRouter.get('/stats', reportsGuard, asyncHandler(async (req, res) => {
  const qs = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  const to = qs.to ?? new Date().toISOString().slice(0, 10);
  const from = qs.from ?? new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
  const a = `${from} 00:00:00`; const b = `${to} 23:59:59`;
  const now = sqlTime(new Date());

  const made = (await q1<any>(pool, 'SELECT COUNT(*) n FROM support_tickets WHERE created_at BETWEEN ? AND ?', [a, b]))!;
  const done = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(AVG(TIMESTAMPDIFF(MINUTE, created_at, resolved_at)),0) avg_resolve,
      COALESCE(SUM(resolved_at <= resolution_due),0) in_target FROM support_tickets WHERE resolved_at BETWEEN ? AND ?`, [a, b]))!;
  const first = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(AVG(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)),0) avg_first,
      COALESCE(SUM(first_response_at <= first_response_due),0) in_target FROM support_tickets WHERE first_response_at BETWEEN ? AND ?`, [a, b]))!;
  const open = (await q1<any>(pool, `SELECT COUNT(*) n, COALESCE(SUM(assignee_id IS NULL),0) unassigned,
      COALESCE(SUM((first_response_at IS NULL AND first_response_due < ?) OR resolution_due < ?),0) breached, COALESCE(SUM(escalation_level > 0),0) escalated
    FROM support_tickets WHERE status IN ('open','in_progress','waiting_customer')`, [now, now]))!;
  const csat = (await q1<any>(pool, 'SELECT COUNT(rating) n, AVG(rating) avg FROM support_tickets WHERE rating IS NOT NULL AND resolved_at BETWEEN ? AND ?', [a, b]))!;
  const byCategory = await q<any>(pool, `SELECT c.name, COUNT(*) n FROM support_tickets t JOIN support_categories c ON c.id = t.category_id
    WHERE t.created_at BETWEEN ? AND ? GROUP BY c.id, c.name ORDER BY n DESC`, [a, b]);
  const byAgent = await q<any>(pool, `SELECT u.id, u.name, COUNT(*) resolved, COALESCE(AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at)),0) avg_resolve
    FROM support_tickets t JOIN users u ON u.id = t.assignee_id WHERE t.resolved_at BETWEEN ? AND ? GROUP BY u.id, u.name ORDER BY resolved DESC`, [a, b]);

  const pct = (x: number, n: number) => (n ? Math.round((x / n) * 1000) / 10 : null);
  res.json({
    range: { from, to },
    created: Number(made.n), resolved: Number(done.n),
    avg_first_response_minutes: Number(first.n) ? Math.round(Number(first.avg_first)) : null,
    avg_resolution_minutes: Number(done.n) ? Math.round(Number(done.avg_resolve)) : null,
    first_response_within_target_pct: pct(Number(first.in_target), Number(first.n)),
    resolved_within_target_pct: pct(Number(done.in_target), Number(done.n)),
    open_now: Number(open.n), unassigned_now: Number(open.unassigned), breached_now: Number(open.breached), escalated_now: Number(open.escalated),
    satisfaction: Number(csat.n) ? { average: Math.round(Number(csat.avg) * 10) / 10, responses: Number(csat.n) } : null,
    by_category: byCategory.map((r) => ({ category: r.name, tickets: Number(r.n) })),
    by_agent: byAgent.map((r) => ({ agent_id: r.id, name: r.name, resolved: Number(r.resolved), avg_resolution_minutes: Math.round(Number(r.avg_resolve)) })),
  });
}));

// ---- configuration (admin) ----
const adminOnly = (req: Request, _res: Response, next: NextFunction) => (req.auth!.role === 'admin' ? next() : next(forbidden('Only the admin can change support settings')));

deskRouter.get('/sla', asyncHandler(async (_req, res) => {
  res.json({ sla: await q(pool, "SELECT priority, first_response_minutes, resolution_minutes FROM support_sla ORDER BY FIELD(priority,'urgent','high','normal','low')") });
}));
deskRouter.put('/sla/:priority', adminOnly, asyncHandler(async (req, res) => {
  const priority = z.enum(PRIORITIES).parse(req.params.priority);
  const b = z.object({ first_response_minutes: z.number().int().min(5).max(43200), resolution_minutes: z.number().int().min(5).max(129600) })
    .refine((v) => v.resolution_minutes >= v.first_response_minutes, 'Resolution cannot be sooner than the first response').parse(req.body);
  await exec(pool, 'UPDATE support_sla SET first_response_minutes = ?, resolution_minutes = ? WHERE priority = ?', [b.first_response_minutes, b.resolution_minutes, priority]);
  await audit(req.auth!.userId, 'support.sla_change', 'support_sla', null, { priority, ...b });
  res.json({ priority, ...b });
}));

deskRouter.post('/categories', adminOnly, asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60), default_priority: z.enum(PRIORITIES).default('normal') }).parse(req.body);
  try {
    const r = await exec(pool, 'INSERT INTO support_categories (name, default_priority, sort_order) VALUES (?,?,100)', [b.name, b.default_priority]);
    res.status(201).json({ id: r.insertId, ...b });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', 'That category already exists');
    throw e;
  }
}));
deskRouter.put('/categories/:id', adminOnly, asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), default_priority: z.enum(PRIORITIES).optional(), is_active: z.boolean().optional() })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM support_categories WHERE id = ?', [id]);
  if (!cur) throw notFound('Category');
  try {
    await exec(pool, 'UPDATE support_categories SET name = ?, default_priority = ?, is_active = ? WHERE id = ?',
      [b.name ?? cur.name, b.default_priority ?? cur.default_priority, b.is_active === undefined ? cur.is_active : b.is_active ? 1 : 0, id]);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXISTS', 'That category already exists');
    throw e;
  }
  res.json({ id });
}));

// =============================================================================================
// Customers: retailers and distributors
// =============================================================================================
export const supportRouter = Router();
supportRouter.use('/desk', deskRouter);

const customer = [authenticate, requireRole('retailer', 'distributor')];

supportRouter.get('/meta', ...customer, asyncHandler(async (_req, res) => {
  res.json({
    categories: await q(pool, "SELECT id, name, default_priority FROM support_categories WHERE is_active = 1 ORDER BY sort_order, name"),
    priorities: CUSTOMER_PRIORITIES,
  });
}));

supportRouter.get('/tickets', ...customer, asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'done', 'all']).default('all') }).parse(req.query);
  const where = status === 'open' ? "AND t.status IN ('open','in_progress','waiting_customer')" : status === 'done' ? "AND t.status IN ('resolved','closed')" : '';
  const rows = await q<any>(pool, `${TICKET_SQL} WHERE t.requester_id = ? ${where} ORDER BY t.last_activity_at DESC LIMIT 100`, [req.auth!.userId]);
  res.json({ tickets: rows.map((t) => { const p = present(t); return { ...p, sla: undefined, escalation_level: undefined, assignee_id: undefined, assignee: undefined }; }) });
}));

supportRouter.post('/tickets', ...customer, asyncHandler(async (req, res) => {
  const b = z.object({
    subject: z.string().trim().min(3).max(150), body: bodyText, category_id: z.number().int().positive(),
    priority: z.enum(['low', 'normal', 'high']).optional(), order_id: z.number().int().positive().optional(),
  }).parse(req.body);
  const a = req.auth!;
  const cat = await q1<any>(pool, 'SELECT * FROM support_categories WHERE id = ? AND is_active = 1', [b.category_id]);
  if (!cat) throw new AppError(400, 'BAD_CATEGORY', 'Choose a category');
  if (b.order_id) {
    const o = await q1(pool, 'SELECT 1 FROM orders WHERE id = ? AND (retailer_id = ? OR distributor_id = ?)', [b.order_id, a.userId, a.userId]);
    if (!o) throw new AppError(400, 'BAD_ORDER', 'That order is not one of yours');
  }
  const open = await q1<any>(pool, "SELECT COUNT(*) n FROM support_tickets WHERE requester_id = ? AND status IN ('open','in_progress','waiting_customer')", [a.userId]);
  if (Number(open!.n) >= MAX_OPEN_PER_USER) throw new AppError(429, 'TOO_MANY_TICKETS', `You have ${MAX_OPEN_PER_USER} open tickets. Wait for some to be resolved.`);

  const priority: Priority = b.priority ?? (CUSTOMER_PRIORITIES.includes(cat.default_priority) ? cat.default_priority : 'high');
  const sla = await slaFor(pool, priority);
  const now = new Date();
  const id = await withTx(async (c) => {
    const r = await exec(c, `INSERT INTO support_tickets (requester_id, requester_role, subject, category_id, priority, order_id, first_response_due, resolution_due, last_activity_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [a.userId, a.role, b.subject, b.category_id, priority, b.order_id ?? null, sqlTime(minutesAfter(now, sla.first)), sqlTime(minutesAfter(now, sla.resolve)), sqlTime(now)]);
    await addMessage(c, { ticketId: r.insertId, authorId: a.userId, side: 'customer', kind: 'reply', body: b.body });
    return r.insertId as number;
  });
  const staff = (await deskAgents()).map((x) => x.id);
  notifyUsers(staff, `New support ticket #${id}`, b.subject, { type: 'support', id });
  res.status(201).json({ ticket: present(await ownTicket(id, a.userId)) });
}));

supportRouter.get('/tickets/:id', ...customer, asyncHandler(async (req, res) => {
  const t = await ownTicket(idParam(req), req.auth!.userId);
  const { assignee_id, assignee, sla, escalation_level, ...rest } = present(t);
  res.json({ ticket: { ...rest, can_reply: t.status !== 'closed', can_close: t.status === 'resolved', can_rate: ['resolved', 'closed'].includes(t.status) && t.rating == null }, ...(await thread(t.id, false)) });
}));

supportRouter.post('/tickets/:id/messages', ...customer, asyncHandler(async (req, res) => {
  const { body } = z.object({ body: bodyText }).parse(req.body);
  const a = req.auth!; const id = idParam(req);
  const t = await ownTicket(id, a.userId);
  if (t.status === 'closed') throw new AppError(409, 'CLOSED', 'This ticket is closed. Start a new one and mention this number.');
  if (t.status === 'resolved' && t.resolved_at && Date.now() - new Date(t.resolved_at).getTime() > REOPEN_DAYS * 86400_000) throw new AppError(409, 'CLOSED', 'This ticket was resolved a while ago. Start a new one.');
  await withTx(async (c) => {
    await addMessage(c, { ticketId: id, authorId: a.userId, side: 'customer', kind: 'reply', body });
    // an answer wakes a ticket that was waiting for them, or reopens one that was resolved
    if (t.status === 'waiting_customer') await exec(c, "UPDATE support_tickets SET status = 'in_progress' WHERE id = ?", [id]);
    if (t.status === 'resolved') await exec(c, "UPDATE support_tickets SET status = 'in_progress', resolved_at = NULL WHERE id = ?", [id]);
  });
  if (t.assignee_id) notifyUsers([t.assignee_id], `Ticket #${id}: new reply`, body.slice(0, 120), { type: 'support', id });
  res.status(201).json({ ok: true });
}));

supportRouter.post('/tickets/:id/close', ...customer, asyncHandler(async (req, res) => {
  const id = idParam(req);
  const t = await ownTicket(id, req.auth!.userId);
  if (t.status !== 'resolved') throw new AppError(409, 'BAD_STATE', 'You can close a ticket once it has been resolved');
  await exec(pool, "UPDATE support_tickets SET status = 'closed', closed_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  res.json({ id, status: 'closed' });
}));

supportRouter.post('/tickets/:id/rate', ...customer, asyncHandler(async (req, res) => {
  const b = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(300).optional() }).parse(req.body);
  const id = idParam(req);
  const t = await ownTicket(id, req.auth!.userId);
  if (!['resolved', 'closed'].includes(t.status)) throw new AppError(409, 'BAD_STATE', 'You can rate a ticket once it is resolved');
  const r = await exec(pool, 'UPDATE support_tickets SET rating = ?, rating_comment = ? WHERE id = ? AND rating IS NULL', [b.rating, b.comment ?? null, id]);
  if (!r.affectedRows) throw new AppError(409, 'ALREADY_RATED', 'You already rated this ticket');
  res.json({ id, rating: b.rating });
}));

// ---- attachments: customers and staff alike; the bytes are checked, not the header, and never served from the public media route ----
const rawFile = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], limit: MAX_BYTES });
const sniff = (b: Buffer): { mime: string; ext: string } | null => {
  const img = sniffImage(b);
  if (img) return { mime: img, ext: img === 'image/jpeg' ? 'jpg' : img === 'image/png' ? 'png' : 'webp' };
  if (b.length > 8 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
};

/** Staff may reach every ticket; a customer only their own. */
async function reachable(req: Request, ticketId: number) {
  const a = req.auth!;
  if (a.role === 'retailer' || a.role === 'distributor') return ownTicket(ticketId, a.userId);
  if (a.role === 'admin' || a.role === 'company_employee') {
    if (a.role === 'company_employee' && !(await loadStaffPermissions(a.userId)).actions.includes('handle_support')) throw forbidden('The admin has not given you the support desk');
    return anyTicket(ticketId);
  }
  throw forbidden();
}

supportRouter.post('/tickets/:id/attachments', authenticate, rawFile, asyncHandler(async (req, res) => {
  const id = idParam(req);
  const t = await reachable(req, id);
  if (t.status === 'closed') throw new AppError(409, 'CLOSED', 'This ticket is closed');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(415, 'BAD_FILE', 'Send a JPEG, PNG, WebP or PDF file as the request body (max 5 MB)');
  const kind = sniff(req.body);
  if (!kind) throw new AppError(415, 'BAD_FILE', 'That file is not a JPEG, PNG, WebP or PDF');
  const count = await q1<any>(pool, 'SELECT COUNT(*) n FROM support_attachments WHERE ticket_id = ?', [id]);
  if (Number(count!.n) >= MAX_ATTACHMENTS) throw new AppError(409, 'TOO_MANY_FILES', `A ticket can hold ${MAX_ATTACHMENTS} files`);
  const name = String(req.query.name ?? `file.${kind.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 100) || `file.${kind.ext}`;
  const key = `support-${crypto.randomBytes(20).toString('hex')}.${kind.ext}`;
  await storage.put(key, req.body, kind.mime);
  const r = await exec(pool, 'INSERT INTO support_attachments (ticket_id, uploaded_by, file_key, file_name, mime, size_bytes) VALUES (?,?,?,?,?,?)', [id, req.auth!.userId, key, name, kind.mime, req.body.length]);
  await exec(pool, 'UPDATE support_tickets SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
  res.status(201).json({ id: r.insertId, name, mime: kind.mime, size: req.body.length });
}));

supportRouter.get('/tickets/:id/attachments/:aid', authenticate, asyncHandler(async (req, res) => {
  const id = idParam(req);
  await reachable(req, id);
  const f = await q1<any>(pool, 'SELECT * FROM support_attachments WHERE id = ? AND ticket_id = ?', [idParam(req, 'aid'), id]);
  if (!f) throw notFound('Attachment');
  const bytes = await storage.read(f.file_key);
  if (!bytes) throw new AppError(410, 'GONE', 'The file is no longer available');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${String(f.file_name).replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
}));
