import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1 } from '../../db/pool';
import { notifyUsers } from '../../services/notify';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { ensureStore } from './store.service';

/*
 * Occasions: birthdays and anniversaries of a customer and their family, so the retailer can wish them (with an offer) in advance.
 * Mounted on the retailer's store router, so the caller is already a signed-in retailer.
 */
export const occasionsRouter = Router();

const optText = (n: number) => z.string().trim().max(n).nullable().optional();
const occasionBody = z.object({
  person_name: z.string().trim().min(1).max(120), relation: optText(40), kind: z.enum(['birthday', 'anniversary', 'other']).default('birthday'), label: optText(80),
  month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31), birth_year: z.number().int().min(1900).max(2100).nullable().optional(), note: optText(255),
});

const istNow = () => { const d = new Date(Date.now() + 5.5 * 3600_000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const dayNo = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** Does 29 February etc. exist (in a leap year)? */
const realDate = (month: number, day: number) => new Date(Date.UTC(2024, month - 1, day)).getUTCMonth() === month - 1;

/** The next time this occasion falls (today counts), and how many days away that is. A 29 February is kept on 28 February in other years. */
export function nextOccurrence(month: number, day: number, now = istNow()) {
  const at = (y: number) => ({ y, m: month, d: month === 2 && day === 29 && !isLeap(y) ? 28 : day });
  let o = at(now.y);
  if (dayNo(o.y, o.m, o.d) < dayNo(now.y, now.m, now.d)) o = at(now.y + 1);
  return { year: o.y, days_until: dayNo(o.y, o.m, o.d) - dayNo(now.y, now.m, now.d) };
}

const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;

/** A ready-to-send wish in the retailer's voice; the retailer can edit it, and add an offer line. */
export function wishText(o: { person_name: string; relation?: string | null; kind: string; label?: string | null; birth_year?: number | null; customer_name: string; store_name: string }, year: number, offer?: string | null) {
  const years = o.birth_year ? year - o.birth_year : 0;
  const nth = years > 0 ? `${ordinal(years)} ` : '';
  const self = /^self$/i.test(o.relation ?? '') || o.person_name === o.customer_name;
  const who = o.relation ? `${o.person_name} (${o.relation})` : o.person_name;
  const head = o.kind === 'other' ? `${o.label || 'Special day'} wishes` : `Happy ${nth}${o.kind}`;
  const to = self ? `, ${o.customer_name}!` : ` to ${who}, ${o.customer_name}!`;
  return `${head}${to} Wishing you a day full of joy. ${offer?.trim() ? `${offer.trim()} ` : ''}- ${o.store_name}`.replace(/\s+/g, ' ').trim();
}

const present = (o: any, storeName: string, withWish = true) => {
  const n = nextOccurrence(o.month, o.day);
  return {
    id: o.id, store_customer_id: o.store_customer_id, person_name: o.person_name, relation: o.relation, kind: o.kind, label: o.label, month: o.month, day: o.day, birth_year: o.birth_year, note: o.note,
    next_on: `${n.year}-${String(o.month).padStart(2, '0')}-${String(o.day).padStart(2, '0')}`, days_until: n.days_until, wished: o.last_wished_year === n.year,
    ...(o.customer_name ? { customer_name: o.customer_name, customer_phone: o.customer_phone, has_app: !!o.customer_id } : {}),
    ...(withWish && o.customer_name ? { wish: wishText({ ...o, store_name: storeName }, n.year) } : {}),
  };
};

const myStore = async (req: any) => { const s = await ensureStore(pool, req.auth.userId); if (!s) throw notFound('Shop'); return s; };
async function ownCustomer(req: any, id: number) {
  const c = await q1<any>(pool, 'SELECT * FROM store_customers WHERE id = ? AND retailer_id = ?', [id, req.auth.userId]);
  if (!c) throw notFound('Customer');
  return c;
}

occasionsRouter.get('/customers/:id/occasions', asyncHandler(async (req, res) => {
  const c = await ownCustomer(req, idParam(req)); const s = await myStore(req);
  const rows = await q<any>(pool, 'SELECT * FROM store_customer_occasions WHERE store_customer_id = ? ORDER BY month, day', [c.id]);
  res.json({ customer: { id: c.id, name: c.name, phone: c.phone }, occasions: rows.map((o) => present(o, s.name, false)) });
}));

occasionsRouter.post('/customers/:id/occasions', asyncHandler(async (req, res) => {
  const c = await ownCustomer(req, idParam(req)); const b = occasionBody.parse(req.body);
  if (!realDate(b.month, b.day)) throw new AppError(400, 'BAD_DATE', 'That date does not exist');
  const n = Number((await q1<any>(pool, 'SELECT COUNT(*) n FROM store_customer_occasions WHERE store_customer_id = ?', [c.id]))!.n);
  if (n >= 30) throw new AppError(400, 'TOO_MANY', 'You can save up to 30 dates for one customer');
  const r = await exec(pool, 'INSERT INTO store_customer_occasions (retailer_id, store_customer_id, person_name, relation, kind, label, month, day, birth_year, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [c.retailer_id, c.id, b.person_name, b.relation ?? null, b.kind, b.label ?? null, b.month, b.day, b.birth_year ?? null, b.note ?? null]);
  res.status(201).json(present((await q1<any>(pool, 'SELECT * FROM store_customer_occasions WHERE id = ?', [r.insertId]))!, (await myStore(req)).name, false));
}));

occasionsRouter.put('/occasions/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM store_customer_occasions WHERE id = ? AND retailer_id = ?', [id, req.auth!.userId]);
  if (!cur) throw notFound('Date');
  const b = occasionBody.partial().parse(req.body);
  const pick = (k: keyof typeof b, old: unknown) => (b[k] === undefined ? old : b[k]);
  const month = pick('month', cur.month) as number; const day = pick('day', cur.day) as number;
  if (!realDate(month, day)) throw new AppError(400, 'BAD_DATE', 'That date does not exist');
  await exec(pool, 'UPDATE store_customer_occasions SET person_name=?, relation=?, kind=?, label=?, month=?, day=?, birth_year=?, note=?, last_wished_year=NULL WHERE id = ?',
    [pick('person_name', cur.person_name), pick('relation', cur.relation), pick('kind', cur.kind), pick('label', cur.label), month, day, pick('birth_year', cur.birth_year), pick('note', cur.note), id]);
  res.json(present((await q1<any>(pool, 'SELECT * FROM store_customer_occasions WHERE id = ?', [id]))!, (await myStore(req)).name, false));
}));

occasionsRouter.delete('/occasions/:id', asyncHandler(async (req, res) => {
  const r = await exec(pool, 'DELETE FROM store_customer_occasions WHERE id = ? AND retailer_id = ?', [idParam(req), req.auth!.userId]);
  if (!r.affectedRows) throw notFound('Date');
  res.status(204).end();
}));

/** The dates in the next days (default 7), nearest first, each with a ready wish. The retailer's dashboard shows these as a reminder. */
occasionsRouter.get('/occasions/upcoming', asyncHandler(async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(0).max(60).default(7) }).parse(req.query);
  const s = await myStore(req);
  const rows = await q<any>(pool, 'SELECT o.*, c.name customer_name, c.phone customer_phone, c.customer_id FROM store_customer_occasions o JOIN store_customers c ON c.id = o.store_customer_id WHERE o.retailer_id = ?', [s.retailer_id]);
  const list = rows.map((o) => present(o, s.name)).filter((o) => o.days_until <= days).sort((a, b) => a.days_until - b.days_until || a.person_name.localeCompare(b.person_name));
  res.json({ occasions: list, pending: list.filter((o) => !o.wished).length });
}));

/** Sends the wish: as a notification to the customer's AAYME app when they have it (otherwise the app opens WhatsApp), and marks this year's wish as done. */
occasionsRouter.post('/occasions/:id/wish', asyncHandler(async (req, res) => {
  const b = z.object({ message: z.string().trim().min(3).max(500), sent_via: z.enum(['app', 'whatsapp', 'other']).default('app') }).parse(req.body);
  const o = await q1<any>(pool, 'SELECT o.*, c.customer_id FROM store_customer_occasions o JOIN store_customers c ON c.id = o.store_customer_id WHERE o.id = ? AND o.retailer_id = ?', [idParam(req), req.auth!.userId]);
  if (!o) throw notFound('Date');
  const s = await myStore(req); const year = nextOccurrence(o.month, o.day).year;
  if (b.sent_via === 'app') {
    if (!o.customer_id) throw new AppError(409, 'NOT_ON_APP', 'This customer is not on the AAYME app yet. Send the wish on WhatsApp instead.');
    notifyUsers([o.customer_id], s.name, b.message, { type: 'store_wish', id: s.retailer_id });
  }
  await exec(pool, 'UPDATE store_customer_occasions SET last_wished_year = ? WHERE id = ?', [year, o.id]);
  res.json({ ok: true, sent_via: b.sent_via });
}));
