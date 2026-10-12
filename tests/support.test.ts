import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/app';
import { exec, pool, q1 } from '../src/db/pool';
import { canMove, escalateOverdue, slaState } from '../src/modules/support/support.service';

const app = createApp();
let n = 0;
const phone = () => String(7900000000 + 950000 + ++n);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function admin() {
  const p = phone();
  const r = await exec(pool, "INSERT INTO users (role, phone, name, password_hash) VALUES ('admin',?,?,?)", [p, 'Admin ' + n, await bcrypt.hash('password123', 4)]);
  const t = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
  return { id: r.insertId as number, token: t };
}
async function agent(a: { token: string }, over: object = {}) {
  const p = phone();
  const s = (await request(app).post('/api/v1/admin/staff').set(auth(a.token)).send({ phone: p, name: 'Agent ' + n, password: 'password123', actions: ['handle_support'], grantable: [], ...over }).expect(201)).body;
  const t = (await request(app).post('/api/v1/auth/login').send({ phone: p, password: 'password123' }).expect(200)).body.access_token as string;
  return { id: s.id as number, token: t };
}
async function reg(role: 'distributor' | 'retailer') {
  const p = phone();
  const body = role === 'distributor'
    ? { role, phone: p, email: `d${p}@t.local`, name: 'Owner', password: 'password123', business_name: 'Biz ' + p }
    : { role, phone: p, email: `r${p}@t.local`, name: 'Retailer', password: 'password123', shop_name: 'Shop ' + p, pincode: '400001' };
  const r = (await request(app).post('/api/v1/auth/register').send(body).expect(201)).body;
  return { id: r.id as number, token: r.access_token as string, phone: p };
}
const cats = async (t: string) => (await request(app).get('/api/v1/support/meta').set(auth(t)).expect(200)).body.categories as { id: number; name: string; default_priority: string }[];
const open = async (u: { token: string }, over: object = {}) => {
  const c = (await cats(u.token)).find((x) => x.name === 'Other')!;
  return (await request(app).post('/api/v1/support/tickets').set(auth(u.token)).send({ subject: 'Where is my order', body: 'It was due yesterday.', category_id: c.id, ...over }).expect(201)).body.ticket;
};
const desk = (t: string, path: string) => request(app).get(`/api/v1/support/desk${path}`).set(auth(t));
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

beforeAll(async () => { await migrate(true); });
afterAll(async () => { await pool.end(); });

describe('ticket rules (pure)', () => {
  it('only allows the documented moves', () => {
    expect(canMove('open', 'in_progress')).toBe(true);
    expect(canMove('waiting_customer', 'in_progress')).toBe(true);
    expect(canMove('resolved', 'in_progress')).toBe(true);
    expect(canMove('resolved', 'open')).toBe(false);
    expect(canMove('closed', 'in_progress')).toBe(false);
    expect(canMove('open', 'closed')).toBe(false);
  });

  it('reports the SLA state of the target that matters now', () => {
    const base = { status: 'open' as const, created_at: '2026-10-01T00:00:00Z', first_response_at: null, first_response_due: '2026-10-01T04:00:00Z', resolution_due: '2026-10-02T00:00:00Z' };
    expect(slaState(base, new Date('2026-10-01T01:00:00Z'))).toBe('ok');
    expect(slaState(base, new Date('2026-10-01T03:30:00Z'))).toBe('due_soon');
    expect(slaState(base, new Date('2026-10-01T05:00:00Z'))).toBe('breached');
    // once answered, the resolution target is what counts
    expect(slaState({ ...base, first_response_at: '2026-10-01T02:00:00Z' }, new Date('2026-10-01T05:00:00Z'))).toBe('ok');
    expect(slaState({ ...base, first_response_at: '2026-10-01T02:00:00Z' }, new Date('2026-10-02T01:00:00Z'))).toBe('breached');
    expect(slaState({ ...base, status: 'resolved' }, new Date('2030-01-01T00:00:00Z'))).toBe('done');
  });
});

describe('raising a ticket', () => {
  it('records the request, the category default priority and the SLA targets', async () => {
    const r = await reg('retailer');
    const orderCat = (await cats(r.token)).find((c) => c.name === 'Order problem')!;
    const t = await open(r, { category_id: orderCat.id });
    expect(t).toMatchObject({ status: 'open', priority: 'high', category: 'Order problem', requester_role: 'retailer' });
    const row = await q1<any>(pool, 'SELECT TIMESTAMPDIFF(MINUTE, created_at, first_response_due) f, TIMESTAMPDIFF(MINUTE, created_at, resolution_due) r FROM support_tickets WHERE id = ?', [t.id]);
    expect([Number(row!.f), Number(row!.r)]).toEqual([240, 1440]);   // the "high" targets
  });

  it('a customer chooses low, normal or high but never urgent', async () => {
    const d = await reg('distributor');
    const c = (await cats(d.token))[0];
    const make = (priority: string) => request(app).post('/api/v1/support/tickets').set(auth(d.token)).send({ subject: 'Help please', body: 'x', category_id: c.id, priority });
    expect((await make('low')).status).toBe(201);
    expect((await make('urgent')).status).toBe(400);
  });

  it('links an order only if it is the requester\'s own', async () => {
    const d = await reg('distributor'); const r = await reg('retailer'); const stranger = await reg('retailer');
    await request(app).post('/api/v1/distributor/retailers').set(auth(d.token)).send({ phone: r.phone }).expect(202);
    await request(app).post(`/api/v1/retailer/link-requests/${d.id}/accept`).set(auth(r.token)).expect(200);
    const pid = (await request(app).post('/api/v1/catalog').set(auth(d.token)).send({ name: 'Rice', price: '10', stock_qty: 5 })).body.id;
    const oid = (await request(app).post('/api/v1/orders').set(auth(r.token)).set('Idempotency-Key', 'sp1').send({ distributor_id: d.id, items: [{ product_id: pid, qty: 1 }] }).expect(201)).body.order.id;
    expect((await open(r, { order_id: oid })).order_id).toBe(oid);
    expect((await open(d, { order_id: oid })).order_id).toBe(oid);                       // the distributor on that order may link it too
    const c = (await cats(stranger.token))[0];
    expect((await request(app).post('/api/v1/support/tickets').set(auth(stranger.token)).send({ subject: 'Not mine', body: 'x', category_id: c.id, order_id: oid })).body.error.code).toBe('BAD_ORDER');
  });

  it('validates the input and keeps tickets private', async () => {
    const r = await reg('retailer'); const other = await reg('retailer');
    const c = (await cats(r.token))[0];
    expect((await request(app).post('/api/v1/support/tickets').set(auth(r.token)).send({ subject: 'ab', body: 'x', category_id: c.id })).status).toBe(400);
    expect((await request(app).post('/api/v1/support/tickets').set(auth(r.token)).send({ subject: 'Fine subject', body: '', category_id: c.id })).status).toBe(400);
    expect((await request(app).post('/api/v1/support/tickets').set(auth(r.token)).send({ subject: 'Fine subject', body: 'x', category_id: 99999 })).body.error.code).toBe('BAD_CATEGORY');
    const t = await open(r);
    expect((await request(app).get(`/api/v1/support/tickets/${t.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).get('/api/v1/support/tickets').set(auth(other.token)).expect(200)).body.tickets).toEqual([]);
    expect((await request(app).post(`/api/v1/support/tickets/${t.id}/messages`).set(auth(other.token)).send({ body: 'hi' })).status).toBe(404);
  });
});

describe('working a ticket', () => {
  it('runs from open to closed, with replies, internal notes and the customer\'s answers', async () => {
    const a = await admin(); const ag = await agent(a); const r = await reg('retailer');
    const t = await open(r);

    // not visible to the customer: internal notes
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/messages`).set(auth(ag.token)).send({ body: 'Checking with the distributor first', internal: true }).expect(201);
    let seen = (await request(app).get(`/api/v1/support/tickets/${t.id}`).set(auth(r.token)).expect(200)).body;
    expect(seen.messages.map((m: any) => m.body)).toEqual(['It was due yesterday.']);
    expect((await desk(ag.token, `/tickets/${t.id}`).expect(200)).body.messages.map((m: any) => m.kind)).toContain('internal');
    expect((await q1<any>(pool, 'SELECT first_response_at f FROM support_tickets WHERE id = ?', [t.id]))!.f).toBeNull();   // a note is not a response

    // the first reply the customer can read is the first response, and it takes the ticket
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/messages`).set(auth(ag.token)).send({ body: 'We are on it.', wait_for_customer: true }).expect(201);
    const row = await q1<any>(pool, 'SELECT status, first_response_at, assignee_id FROM support_tickets WHERE id = ?', [t.id]);
    expect(row).toMatchObject({ status: 'waiting_customer', assignee_id: ag.id });
    expect(row!.first_response_at).not.toBeNull();

    // the customer answers: it wakes up
    await request(app).post(`/api/v1/support/tickets/${t.id}/messages`).set(auth(r.token)).send({ body: 'Order number 12.' }).expect(201);
    expect((await q1<any>(pool, 'SELECT status FROM support_tickets WHERE id = ?', [t.id]))!.status).toBe('in_progress');

    // resolve needs a note
    expect((await request(app).post(`/api/v1/support/desk/tickets/${t.id}/resolve`).set(auth(ag.token)).send({})).status).toBe(400);
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/resolve`).set(auth(ag.token)).send({ note: 'Delivered this morning.' }).expect(200);
    seen = (await request(app).get(`/api/v1/support/tickets/${t.id}`).set(auth(r.token)).expect(200)).body;
    expect(seen.ticket).toMatchObject({ status: 'resolved', resolution_note: 'Delivered this morning.', can_close: true, can_rate: true });
    expect(seen.ticket.assignee).toBeUndefined();            // staff internals are not shown to customers
    expect(seen.ticket.sla).toBeUndefined();

    // a reply reopens it; resolving again, then the customer closes and rates (once)
    await request(app).post(`/api/v1/support/tickets/${t.id}/messages`).set(auth(r.token)).send({ body: 'Still not here.' }).expect(201);
    expect((await q1<any>(pool, 'SELECT status FROM support_tickets WHERE id = ?', [t.id]))!.status).toBe('in_progress');
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/resolve`).set(auth(ag.token)).send({ note: 'Re-sent.' }).expect(200);
    await request(app).post(`/api/v1/support/tickets/${t.id}/rate`).set(auth(r.token)).send({ rating: 4, comment: 'Quick' }).expect(200);
    expect((await request(app).post(`/api/v1/support/tickets/${t.id}/rate`).set(auth(r.token)).send({ rating: 1 })).body.error.code).toBe('ALREADY_RATED');
    await request(app).post(`/api/v1/support/tickets/${t.id}/close`).set(auth(r.token)).expect(200);
    expect((await request(app).post(`/api/v1/support/tickets/${t.id}/messages`).set(auth(r.token)).send({ body: 'More' })).body.error.code).toBe('CLOSED');
    expect((await request(app).post(`/api/v1/support/desk/tickets/${t.id}/messages`).set(auth(ag.token)).send({ body: 'More' })).body.error.code).toBe('CLOSED');
  });

  it('assignment: staff take a ticket for themselves; only the admin hands it to someone else', async () => {
    const a = await admin(); const a1 = await agent(a); const a2 = await agent(a); const r = await reg('retailer');
    const t = await open(r);
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/assign`).set(auth(a1.token)).send({ assignee_id: a1.id }).expect(200);
    expect((await request(app).post(`/api/v1/support/desk/tickets/${t.id}/assign`).set(auth(a1.token)).send({ assignee_id: a2.id })).status).toBe(403);
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/assign`).set(auth(a.token)).send({ assignee_id: a2.id }).expect(200);
    const outsider = await reg('retailer');
    expect((await request(app).post(`/api/v1/support/desk/tickets/${t.id}/assign`).set(auth(a.token)).send({ assignee_id: outsider.id })).body.error.code).toBe('NOT_AN_AGENT');

    const mine = (await desk(a2.token, '/tickets?assignee=me').expect(200)).body.tickets;
    expect(mine.map((x: any) => x.id)).toEqual([t.id]);
    expect((await desk(a1.token, '/tickets?assignee=me').expect(200)).body.tickets).toEqual([]);
    expect((await desk(a1.token, '/tickets?assignee=none').expect(200)).body.tickets.map((x: any) => x.id)).not.toContain(t.id);
  });

  it('changing the priority recomputes the targets from when the ticket was raised', async () => {
    const a = await admin(); const r = await reg('retailer');
    const t = await open(r, { priority: 'low' });
    await request(app).put(`/api/v1/support/desk/tickets/${t.id}`).set(auth(a.token)).send({ priority: 'urgent' }).expect(200);
    const row = await q1<any>(pool, 'SELECT priority, TIMESTAMPDIFF(MINUTE, created_at, first_response_due) f, TIMESTAMPDIFF(MINUTE, created_at, resolution_due) r FROM support_tickets WHERE id = ?', [t.id]);
    expect({ p: row!.priority, f: Number(row!.f), r: Number(row!.r) }).toEqual({ p: 'urgent', f: 60, r: 480 });
  });

  it('the queue puts the most urgent first and can show only overdue tickets', async () => {
    const a = await admin(); const r = await reg('retailer');
    await exec(pool, "UPDATE support_tickets SET status = 'closed'");        // a clean queue for this test
    const low = await open(r, { priority: 'low' }); const high = await open(r, { priority: 'high' });
    const list = (await desk(a.token, '/tickets').expect(200)).body.tickets.map((x: any) => x.id);
    expect(list.indexOf(high.id)).toBeLessThan(list.indexOf(low.id));
    await exec(pool, 'UPDATE support_tickets SET first_response_due = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?', [low.id]);
    expect((await desk(a.token, '/tickets?overdue=1').expect(200)).body.tickets.map((x: any) => x.id)).toEqual([low.id]);
  });
});

describe('who may use the desk', () => {
  it('needs the handle_support power, through a person\'s own set or a role', async () => {
    const a = await admin(); const r = await reg('retailer'); const d = await reg('distributor');
    const none = await agent(a, { actions: ['create_distributors'] });
    expect((await desk(none.token, '/tickets')).status).toBe(403);
    expect((await desk(r.token, '/tickets')).status).toBe(403);
    expect((await desk(d.token, '/tickets')).status).toBe(403);
    expect((await request(app).get('/api/v1/support/desk/tickets')).status).toBe(401);

    const role = (await request(app).post('/api/v1/admin/roles').set(auth(a.token)).send({ name: 'Support ' + n, actions: ['handle_support'], grantable: [] }).expect(201)).body;
    const viaRole = await agent(a, { actions: [], role_id: role.id });
    expect((await desk(viaRole.token, '/tickets')).status).toBe(200);
    // switching the role's power off takes effect at once
    await request(app).put(`/api/v1/admin/roles/${role.id}`).set(auth(a.token)).send({ actions: [] }).expect(200);
    expect((await desk(viaRole.token, '/tickets')).status).toBe(403);
  });

  it('only the admin changes the service levels and categories', async () => {
    const a = await admin(); const ag = await agent(a);
    expect((await request(app).put('/api/v1/support/desk/sla/high').set(auth(ag.token)).send({ first_response_minutes: 10, resolution_minutes: 60 })).status).toBe(403);
    await request(app).put('/api/v1/support/desk/sla/high').set(auth(a.token)).send({ first_response_minutes: 120, resolution_minutes: 600 }).expect(200);
    expect((await request(app).put('/api/v1/support/desk/sla/high').set(auth(a.token)).send({ first_response_minutes: 100, resolution_minutes: 50 })).status).toBe(400);
    const r = await reg('retailer');
    const orderCat = (await cats(r.token)).find((c) => c.name === 'Order problem')!;
    const t = await open(r, { category_id: orderCat.id });
    const row = await q1<any>(pool, 'SELECT TIMESTAMPDIFF(MINUTE, created_at, first_response_due) f FROM support_tickets WHERE id = ?', [t.id]);
    expect(Number(row!.f)).toBe(120);                                        // a new ticket uses the new target
    expect((await request(app).post('/api/v1/support/desk/categories').set(auth(ag.token)).send({ name: 'Mine' })).status).toBe(403);
    await request(app).post('/api/v1/support/desk/categories').set(auth(a.token)).send({ name: 'Delivery partner', default_priority: 'high' }).expect(201);
  });
});

describe('escalation', () => {
  it('escalates once per level, tells staff, and does not repeat', async () => {
    const a = await admin(); const r = await reg('retailer');
    const t = await open(r);
    await exec(pool, 'UPDATE support_tickets SET first_response_due = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?', [t.id]);
    await escalateOverdue();
    await escalateOverdue();                                                  // a second run changes nothing
    expect((await q1<any>(pool, 'SELECT escalation_level l FROM support_tickets WHERE id = ?', [t.id]))!.l).toBe(1);
    const msgs = (await desk(a.token, `/tickets/${t.id}`).expect(200)).body.messages.filter((m: any) => /Escalated/.test(m.body));
    expect(msgs).toHaveLength(1);
    // the customer never sees the escalation note
    expect((await request(app).get(`/api/v1/support/tickets/${t.id}`).set(auth(r.token))).body.messages.some((m: any) => /Escalated/.test(m.body))).toBe(false);

    await exec(pool, 'UPDATE support_tickets SET resolution_due = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [t.id]);
    await escalateOverdue();
    expect((await q1<any>(pool, 'SELECT escalation_level l FROM support_tickets WHERE id = ?', [t.id]))!.l).toBe(2);
  });

  it('does not escalate a ticket that is waiting on the customer or already resolved, and closes old resolved ones', async () => {
    const a = await admin(); const ag = await agent(a); const r = await reg('retailer');
    const waiting = await open(r);
    await request(app).post(`/api/v1/support/desk/tickets/${waiting.id}/messages`).set(auth(ag.token)).send({ body: 'Need more info', wait_for_customer: true }).expect(201);
    await exec(pool, 'UPDATE support_tickets SET resolution_due = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?', [waiting.id]);
    const old = await open(r);
    await request(app).post(`/api/v1/support/desk/tickets/${old.id}/resolve`).set(auth(ag.token)).send({ note: 'Done' }).expect(200);
    await exec(pool, 'UPDATE support_tickets SET resolved_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY) WHERE id = ?', [old.id]);
    const out = await escalateOverdue();
    expect(out.closed).toBeGreaterThanOrEqual(1);
    expect((await q1<any>(pool, 'SELECT escalation_level l FROM support_tickets WHERE id = ?', [waiting.id]))!.l).toBe(0);
    expect((await q1<any>(pool, 'SELECT status FROM support_tickets WHERE id = ?', [old.id]))!.status).toBe('closed');
  });
});

describe('attachments', () => {
  const up = (t: string, id: number, body: Buffer, type: string, name = 'proof.png') =>
    request(app).post(`/api/v1/support/tickets/${id}/attachments`).query({ name }).set(auth(t)).set('Content-Type', type).send(body);

  it('accepts a real image, checks the bytes, and serves it only to the ticket\'s people', async () => {
    const a = await admin(); const ag = await agent(a); const r = await reg('retailer'); const other = await reg('retailer');
    const t = await open(r);
    const ok = await up(r.token, t.id, png(), 'image/png', '../../etc/passwd.png');
    expect(ok.status).toBe(201);
    expect(ok.body.name).not.toContain('/');
    expect((await up(r.token, t.id, Buffer.from('<script>alert(1)</script>'), 'image/png')).status).toBe(415);   // not really a PNG
    expect((await up(r.token, t.id, Buffer.from('MZ not an image'), 'application/octet-stream')).status).toBe(415);

    const dl = await request(app).get(`/api/v1/support/tickets/${t.id}/attachments/${ok.body.id}`).set(auth(r.token)).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c)));
    }).expect(200);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['cache-control']).toContain('no-store');
    expect((dl.body as Buffer).equals(png())).toBe(true);
    await request(app).get(`/api/v1/support/tickets/${t.id}/attachments/${ok.body.id}`).set(auth(ag.token)).expect(200);          // staff can open it
    expect((await request(app).get(`/api/v1/support/tickets/${t.id}/attachments/${ok.body.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/support/tickets/${t.id}/attachments/${ok.body.id}`)).status).toBe(401);
    const files = (await request(app).get(`/api/v1/support/tickets/${t.id}`).set(auth(r.token))).body.attachments;
    expect(files).toHaveLength(1);
    expect(files[0]).not.toHaveProperty('file_key');
  });

  it('accepts a PDF and limits how many files one ticket can hold', async () => {
    const r = await reg('retailer');
    const t = await open(r);
    const pdf = Buffer.from('%PDF-1.4\n%fake but starts like a pdf\n');
    expect((await up(r.token, t.id, pdf, 'application/pdf', 'invoice.pdf')).status).toBe(201);
    for (let i = 0; i < 4; i++) await up(r.token, t.id, png(), 'image/png').expect(201);
    expect((await up(r.token, t.id, png(), 'image/png')).body.error.code).toBe('TOO_MANY_FILES');
  });
});

describe('performance report', () => {
  it('counts what was handled, response times and satisfaction, for staff who may see it', async () => {
    const a = await admin(); const ag = await agent(a); const noReports = await agent(a); const r = await reg('retailer');
    // the report is platform-wide, so start from a clean slate: nothing open, nothing rated, nothing resolved before today
    await exec(pool, "UPDATE support_tickets SET status = 'closed', rating = NULL, resolved_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY), created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY), first_response_at = NULL");
    const t = await open(r);
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/messages`).set(auth(ag.token)).send({ body: 'Looking' }).expect(201);
    await request(app).post(`/api/v1/support/desk/tickets/${t.id}/resolve`).set(auth(ag.token)).send({ note: 'Sorted' }).expect(200);
    await request(app).post(`/api/v1/support/tickets/${t.id}/rate`).set(auth(r.token)).send({ rating: 5 }).expect(200);
    await open(r);                                                            // one still open, unassigned

    const s = (await desk(a.token, '/stats').expect(200)).body;
    expect(s.created).toBe(2);
    expect(s.resolved).toBe(1);
    expect(s).toMatchObject({ open_now: 1, unassigned_now: 1, first_response_within_target_pct: 100 });
    expect(s.satisfaction).toMatchObject({ average: 5 });
    expect(s.by_agent.find((x: any) => x.agent_id === ag.id)).toMatchObject({ resolved: 1 });
    expect(s.by_category.length).toBeGreaterThan(0);

    expect((await desk(noReports.token, '/stats')).status).toBe(403);         // can work tickets, cannot see the performance report
    const reporter = await agent(a, { actions: ['handle_support', 'support_reports'] });
    expect((await desk(reporter.token, '/stats')).status).toBe(200);
  });
});
