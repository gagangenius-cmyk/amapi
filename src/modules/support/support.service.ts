import { Conn, exec, pool, q, q1 } from '../../db/pool';
import { notifyUsers } from '../../services/notify';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { effectivePermissions } from '../staff/permissions';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Status = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';

/**
 * TICKET LIFE
 *   open -> in_progress -> (waiting_customer <-> in_progress) -> resolved -> closed
 * Staff move a ticket forward; a customer reply wakes it (waiting_customer -> in_progress, or resolved -> in_progress within
 * REOPEN_DAYS). A resolved ticket closes by itself after REOPEN_DAYS of silence, or when the customer closes it.
 *
 * SLA: the first-response and resolution targets come from support_sla by priority, counted in minutes from creation and
 * running around the clock. A change of priority recomputes both from the creation time. A ticket is "breached" when a target
 * has passed without being met.
 */
export const REOPEN_DAYS = 7;
export const CUSTOMER_PRIORITIES: Priority[] = ['low', 'normal', 'high'];   // urgent is for staff to decide

const MOVES: Record<Status, Status[]> = {
  open: ['in_progress', 'waiting_customer', 'resolved'],
  in_progress: ['open', 'waiting_customer', 'resolved'],
  waiting_customer: ['open', 'in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};
export const canMove = (from: Status, to: Status) => from === to || MOVES[from].includes(to);

export async function slaFor(c: Conn, p: Priority) {
  const r = await q1<{ first_response_minutes: number; resolution_minutes: number }>(c, 'SELECT first_response_minutes, resolution_minutes FROM support_sla WHERE priority = ?', [p]);
  return { first: r?.first_response_minutes ?? 480, resolve: r?.resolution_minutes ?? 2880 };
}

export const minutesAfter = (from: Date | string, minutes: number) => new Date(new Date(from).getTime() + minutes * 60_000);
export const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/** ok | due_soon (under a quarter of the target left) | breached, for the target that matters right now. */
export function slaState(t: { status: Status; first_response_at: string | Date | null; first_response_due: string | Date; resolution_due: string | Date; created_at: string | Date }, now = new Date()): 'ok' | 'due_soon' | 'breached' | 'done' {
  if (t.status === 'resolved' || t.status === 'closed') return 'done';
  const waitingFirst = !t.first_response_at;
  const due = new Date(waitingFirst ? t.first_response_due : t.resolution_due).getTime();
  const start = new Date(t.created_at).getTime();
  const left = due - now.getTime();
  if (left < 0) return 'breached';
  return left < (due - start) * 0.25 ? 'due_soon' : 'ok';
}

// ---------------------------------------------------------------------------------------------
// Who works the desk
// ---------------------------------------------------------------------------------------------
/** Active admins and company employees allowed to handle support (through their own permissions or their role). */
export async function deskAgents(c: Conn = pool): Promise<{ id: number; name: string; role: 'admin' | 'company_employee' }[]> {
  const rows = await q<any>(c, `SELECT u.id, u.name, u.role, u.staff_permissions, r.actions role_actions, r.grantable role_grantable
    FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1 AND u.role IN ('admin','company_employee') ORDER BY u.name`);
  return rows
    .filter((u) => u.role === 'admin' || effectivePermissions(u).actions.includes('handle_support'))
    .map((u) => ({ id: u.id, name: u.name, role: u.role }));
}

export async function isDeskAgent(c: Conn, userId: number): Promise<boolean> {
  return (await deskAgents(c)).some((a) => a.id === userId);
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------
export async function addMessage(c: Conn, o: { ticketId: number; authorId: number | null; side: 'customer' | 'staff' | 'system'; kind: 'reply' | 'internal' | 'system'; body: string }) {
  const r = await exec(c, 'INSERT INTO support_messages (ticket_id, author_id, author_side, kind, body) VALUES (?,?,?,?,?)', [o.ticketId, o.authorId, o.side, o.kind, o.body.slice(0, 4000)]);
  // an internal note is not activity the customer can see, but the ticket is still being worked
  await exec(c, 'UPDATE support_tickets SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [o.ticketId]);
  return r.insertId as number;
}

// ---------------------------------------------------------------------------------------------
// Escalation and housekeeping (a periodic job; every step is a conditional update, so running it twice is harmless)
// ---------------------------------------------------------------------------------------------
export async function escalateOverdue(now = new Date()): Promise<{ escalated: number; closed: number }> {
  const t = sqlTime(now);
  let escalated = 0;
  const rows = await q<any>(pool, `SELECT id, requester_id, assignee_id, escalation_level,
      (first_response_at IS NULL AND first_response_due < ?) first_breach, (resolution_due < ?) resolve_breach
    FROM support_tickets WHERE status IN ('open','in_progress') AND ((first_response_at IS NULL AND first_response_due < ?) OR resolution_due < ?)`, [t, t, t, t]);
  for (const r of rows) {
    const target = r.resolve_breach ? 2 : 1;
    if (target <= r.escalation_level) continue;
    const upd = await exec(pool, 'UPDATE support_tickets SET escalation_level = ?, escalated_at = ? WHERE id = ? AND escalation_level < ?', [target, t, r.id, target]);
    if (!upd.affectedRows) continue;     // another run got there first
    escalated++;
    const why = target === 2 ? 'The resolution target has passed.' : 'The first-response target has passed.';
    await addMessage(pool, { ticketId: r.id, authorId: null, side: 'system', kind: 'internal', body: `Escalated (level ${target}). ${why}` });
    const agents = await deskAgents(pool);
    notifyUsers([...new Set([...agents.filter((a) => a.role === 'admin').map((a) => a.id), ...(r.assignee_id ? [r.assignee_id] : [])])],
      `Support ticket #${r.id} escalated`, why, { type: 'support', id: r.id });
  }
  const closed = await exec(pool, "UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE status = 'resolved' AND resolved_at < ?", [t, sqlTime(new Date(now.getTime() - REOPEN_DAYS * 86400_000))]);
  return { escalated, closed: closed.affectedRows };
}

let timer: NodeJS.Timeout | null = null;
export function startSupportWorker(everyMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => { escalateOverdue().catch((err) => logger.error({ err }, 'support escalation failed')); }, everyMs);
  timer.unref();
}

export const badState = (from: Status, to: Status) => new AppError(409, 'BAD_STATE', `A ${from.replace('_', ' ')} ticket cannot become ${to.replace('_', ' ')}`);
