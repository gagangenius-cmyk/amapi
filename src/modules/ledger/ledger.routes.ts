import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, idempotencyKey, requireRole } from '../../middleware/auth';
import { AppError, asyncHandler, forbidden } from '../../utils/errors';
import { fromPaise, toPaise } from '../../utils/money';
import { assertPermission, assertSubscriptionActive } from '../distributors/subscription';
import { audit } from '../../utils/audit';
import { idParam } from '../../utils/http';
import { notifyUsers, teamOf } from '../../services/notify';
import { invoiceLines } from './aging';
import { LedgerType, postLedger, statement, validateDenominations } from './ledger.service';

export const ledgerRouter = Router();

export function presentRow(r: any) {
  return {
    id: r.id, distributor_id: r.distributor_id, retailer_id: r.retailer_id, order_id: r.order_id, type: r.type,
    amount: fromPaise(Number(r.amount_paise)), delta: fromPaise(Number(r.delta_paise)),
    balance_after: fromPaise(Number(r.balance_after_paise)), payment_mode: r.payment_mode,
    cash_denominations: r.cash_denominations ? JSON.parse(r.cash_denominations) : null,
    reversal_of: r.reversal_of, notes: r.notes, created_by: r.created_by, created_at: r.created_at,
    dispute: r.dispute_id ? { id: r.dispute_id, status: r.dispute_status, reason: r.dispute_reason } : null,
  };
}

/** Runs a posting; maps unique-key races (duplicate idempotency key / double reversal) to clean responses. */
async function safePost(input: Parameters<typeof postLedger>[1]) {
  try {
    return await withTx((c) => postLedger(c, input));
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') {
      if (String(e.message).includes('uq_ledger_reversal')) throw new AppError(409, 'ALREADY_REVERSED', 'Transaction already reversed');
      const row = await q1<any>(pool, 'SELECT * FROM ledger_transactions WHERE created_by = ? AND idempotency_key = ?', [input.createdBy, input.idempotencyKey]);
      if (row) return { row, replayed: true };
    }
    throw e;
  }
}

const postSchema = z.object({
  retailer_id: z.number().int().positive(),
  distributor_id: z.number().int().positive().optional(),
  transaction_type: z.enum(['payment_cash', 'credit_note', 'debit_note']),
  amount: z.union([z.string(), z.number()]),
  cash_denominations: z.record(z.string(), z.number()).optional(),
  notes: z.string().max(500).optional(),
});

// Distributor / employee records a cash payment or an adjustment note.
ledgerRouter.post('/transaction', authenticate, requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const b = postSchema.parse(req.body);
  const key = idempotencyKey(req);
  const distributorId = req.auth!.distributorId!;
  if (b.distributor_id && b.distributor_id !== distributorId) throw forbidden('Cannot post to another distributor');
  if (req.auth!.role === 'employee' && b.transaction_type !== 'payment_cash') throw forbidden('Employees may only record cash collection');

  await assertSubscriptionActive(pool, distributorId);
  await assertPermission(pool, distributorId, 'khatabook_enabled');

  const amountPaise = toPaise(b.amount);
  if (b.transaction_type === 'payment_cash') validateDenominations(b.cash_denominations, amountPaise);

  const { row, replayed } = await safePost({
    distributorId, retailerId: b.retailer_id, type: b.transaction_type as LedgerType, amountPaise,
    createdBy: req.auth!.userId, idempotencyKey: key, paymentMode: b.transaction_type === 'payment_cash' ? 'cash' : null,
    denominations: b.transaction_type === 'payment_cash' ? b.cash_denominations : undefined, notes: b.notes,
  });
  if (!replayed) {
    await audit(req.auth!.userId, `ledger.${b.transaction_type}`, 'ledger', row.id, { retailer_id: b.retailer_id, amount: b.amount });
    const what = { payment_cash: 'Cash payment recorded', credit_note: 'Credit note added', debit_note: 'Debit note added' }[b.transaction_type];
    notifyUsers([b.retailer_id], what, `₹${fromPaise(amountPaise)} in your khata. Tap to review, and dispute it if it is wrong.`, { type: 'payment' });
  }
  res.status(replayed ? 200 : 201).json({ replayed, transaction: presentRow(row) });
}));

ledgerRouter.post('/transaction/:id/reverse', authenticate, requireRole('distributor'), asyncHandler(async (req, res) => {
  const key = idempotencyKey(req);
  const distributorId = req.auth!.distributorId!;
  const orig = await q1<any>(pool, 'SELECT * FROM ledger_transactions WHERE id = ? AND distributor_id = ?', [idParam(req), distributorId]);
  if (!orig) throw new AppError(404, 'NOT_FOUND', 'Transaction not found');
  const { row, replayed } = await safePost({
    distributorId, retailerId: orig.retailer_id, type: 'reversal', amountPaise: Number(orig.amount_paise), reversalOf: orig.id,
    createdBy: req.auth!.userId, idempotencyKey: key, notes: z.string().max(500).optional().parse(req.body?.notes),
  });
  if (!replayed) await audit(req.auth!.userId, 'ledger.reversal', 'ledger', row.id, { reversal_of: orig.id });
  res.status(replayed ? 200 : 201).json({ replayed, transaction: presentRow(row) });
}));

// Payment gateway webhook (online payments). Deduped on the gateway's event id.
ledgerRouter.post('/webhook/payment', asyncHandler(async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  const given = Buffer.from(req.header('x-webhook-secret') ?? '');
  const want = Buffer.from(secret ?? '');
  if (!secret || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new AppError(401, 'UNAUTHENTICATED', 'Bad webhook secret');
  const b = z.object({
    event_id: z.string().min(1).max(80), distributor_id: z.number().int(), retailer_id: z.number().int(),
    amount: z.union([z.string(), z.number()]), order_id: z.number().int().optional(),
  }).parse(req.body);
  const { row, replayed } = await safePost({
    distributorId: b.distributor_id, retailerId: b.retailer_id, type: 'payment_online', amountPaise: toPaise(b.amount),
    createdBy: b.retailer_id, idempotencyKey: `gw:${b.event_id}`.slice(0, 80), gatewayEventId: b.event_id, orderId: b.order_id, paymentMode: 'online',
  });
  res.status(replayed ? 200 : 201).json({ replayed, transaction: presentRow(row) });
}));

// Statement as a spreadsheet (CSV), whole history. Cells that start with = + - @ are neutralised so Excel never runs them as formulas.
const csvCell = (v: unknown) => {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
ledgerRouter.get('/statement.csv', authenticate, asyncHandler(async (req, res) => {
  const a = req.auth!;
  const qs = z.object({ distributor_id: z.coerce.number().int().optional(), retailer_id: z.coerce.number().int().optional() }).parse(req.query);
  let distributorId: number, retailerId: number;
  if (a.role === 'retailer') { if (!qs.distributor_id) throw new AppError(400, 'VALIDATION', 'distributor_id required'); distributorId = qs.distributor_id; retailerId = a.userId; }
  else if (a.role === 'distributor' || a.role === 'employee') { if (!qs.retailer_id) throw new AppError(400, 'VALIDATION', 'retailer_id required'); distributorId = a.distributorId!; retailerId = qs.retailer_id; }
  else throw forbidden();
  const rel = await q1<any>(pool, "SELECT balance_due_paise FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active'", [retailerId, distributorId]);
  if (!rel) throw new AppError(404, 'NOT_FOUND', 'Relation not found');
  const rows = await q<any>(pool, 'SELECT * FROM ledger_transactions WHERE distributor_id = ? AND retailer_id = ? ORDER BY id LIMIT 20000', [distributorId, retailerId]);
  const head = ['Date (UTC)', 'Entry no.', 'Type', 'Order', 'Debit (owed)', 'Credit (paid)', 'Balance after', 'Mode', 'Notes'];
  const lines = rows.map((r) => {
    const d = Number(r.delta_paise);
    return [new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19), r.id, r.type, r.order_id ?? '', d > 0 ? fromPaise(d) : '', d < 0 ? fromPaise(-d) : '', fromPaise(Number(r.balance_after_paise)), r.payment_mode ?? '', r.notes ?? ''].map(csvCell).join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="khata-${distributorId}-${retailerId}.csv"`);
  res.send('\uFEFF' + [head.join(','), ...lines].join('\r\n') + '\r\n');
}));

// Invoice by invoice: what each bill was for, how much has come in against it, and what is still due.
// Payments are applied to the oldest bill first. Open to the retailer, the distributor and delivery staff (who collect payments).
ledgerRouter.get('/invoices', authenticate, asyncHandler(async (req, res) => {
  const a = req.auth!;
  const qs = z.object({
    distributor_id: z.coerce.number().int().optional(), retailer_id: z.coerce.number().int().optional(),
    status: z.enum(['all', 'open']).default('all'),
  }).parse(req.query);
  let distributorId: number, retailerId: number;
  if (a.role === 'retailer') { if (!qs.distributor_id) throw new AppError(400, 'VALIDATION', 'distributor_id required'); distributorId = qs.distributor_id; retailerId = a.userId; }
  else if (a.role === 'distributor' || a.role === 'employee') { if (!qs.retailer_id) throw new AppError(400, 'VALIDATION', 'retailer_id required'); distributorId = a.distributorId!; retailerId = qs.retailer_id; }
  else throw forbidden();
  const rel = await q1<any>(pool, "SELECT balance_due_paise, credit_days FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active'", [retailerId, distributorId]);
  if (!rel) throw new AppError(404, 'NOT_FOUND', 'Relation not found');
  const rows = await q<any>(pool, 'SELECT id, reversal_of, order_id, type, delta_paise, created_at FROM ledger_transactions WHERE distributor_id = ? AND retailer_id = ? ORDER BY id', [distributorId, retailerId]);
  const { lines, cancelled, advance } = invoiceLines(rows, new Date(), rel.credit_days);
  const orderIds = [...new Set([...lines, ...cancelled].map((l) => l.order_id).filter((x): x is number => x != null))];
  const nos = new Map<number, string | null>((orderIds.length ? await q<any>(pool, 'SELECT id, invoice_no FROM orders WHERE id IN (?)', [orderIds]) : []).map((o) => [o.id, o.invoice_no]));
  const shown = [...lines, ...(qs.status === 'all' ? cancelled : [])].filter((l) => qs.status === 'all' || l.outstanding > 0).sort((x, y) => (y.id ?? 0) - (x.id ?? 0));
  const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((t, l) => t + f(l), 0);
  res.json({
    totals: { invoiced: fromPaise(sum((l) => l.amount)), received: fromPaise(sum((l) => l.paid)), outstanding: fromPaise(sum((l) => l.outstanding)), advance: fromPaise(advance), balance_due: fromPaise(Number(rel.balance_due_paise)) },
    credit_days: rel.credit_days,
    invoices: shown.map((l) => ({
      entry_id: l.id, kind: l.type, order_id: l.order_id, invoice_no: l.order_id ? nos.get(l.order_id) ?? null : null,
      date: l.created_at, due_date: l.due_at, amount: fromPaise(l.amount), paid: fromPaise(l.paid), outstanding: fromPaise(l.outstanding), status: l.status, days_overdue: l.days_overdue,
    })),
  });
}));

// Statement: retailer sees own account with a distributor; distributor/employee see a retailer's account.
ledgerRouter.get('/statement', authenticate, asyncHandler(async (req, res) => {
  const a = req.auth!;
  const qs = z.object({
    distributor_id: z.coerce.number().int().optional(), retailer_id: z.coerce.number().int().optional(),
    before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  let distributorId: number, retailerId: number;
  if (a.role === 'retailer') {
    if (!qs.distributor_id) throw new AppError(400, 'VALIDATION', 'distributor_id required');
    distributorId = qs.distributor_id; retailerId = a.userId;
  } else if (a.role === 'distributor' || a.role === 'employee') {
    if (!qs.retailer_id) throw new AppError(400, 'VALIDATION', 'retailer_id required');
    distributorId = a.distributorId!; retailerId = qs.retailer_id;
  } else throw forbidden();
  const s = await statement(pool, distributorId, retailerId, qs.before, qs.limit);
  res.json({ balance_due: fromPaise(s.balance_due_paise), transactions: s.rows.map(presentRow) });
}));

// ---------- Disputes: the retailer can contest any entry; the distributor must answer ----------
ledgerRouter.post('/transaction/:id/dispute', authenticate, requireRole('retailer'), asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
  const row = await q1<any>(pool, 'SELECT id, distributor_id, retailer_id, amount_paise, type FROM ledger_transactions WHERE id = ? AND retailer_id = ?', [id, req.auth!.userId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Transaction not found');
  try {
    const r = await exec(pool, 'INSERT INTO ledger_disputes (ledger_id, distributor_id, retailer_id, reason) VALUES (?,?,?,?)', [row.id, row.distributor_id, row.retailer_id, reason]);
    await audit(req.auth!.userId, 'ledger.dispute_opened', 'ledger', row.id, { dispute_id: r.insertId });
    teamOf(row.distributor_id).then((t) => notifyUsers(t, 'Khata entry disputed', `A retailer disputes a ₹${fromPaise(Number(row.amount_paise))} ${row.type.replace('_', ' ')}: ${reason.slice(0, 80)}`, { type: 'payment' }));
    res.status(201).json({ dispute: { id: r.insertId, ledger_id: row.id, status: 'open', reason } });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw new AppError(409, 'ALREADY_DISPUTED', 'This entry already has a dispute');
    throw e;
  }
}));

ledgerRouter.get('/disputes', authenticate, asyncHandler(async (req, res) => {
  const a = req.auth!;
  const base = `SELECT d.*, l.type, l.amount_paise, l.created_at AS entry_at, rp.shop_name, dp.business_name
    FROM ledger_disputes d JOIN ledger_transactions l ON l.id = d.ledger_id
    JOIN retailer_profiles rp ON rp.user_id = d.retailer_id JOIN distributor_profiles dp ON dp.user_id = d.distributor_id`;
  let rows: any[];
  if (a.role === 'retailer') rows = await q<any>(pool, `${base} WHERE d.retailer_id = ? ORDER BY d.id DESC LIMIT 100`, [a.userId]);
  else if (a.role === 'distributor' || a.role === 'employee') rows = await q<any>(pool, `${base} WHERE d.distributor_id = ? ORDER BY d.status = 'open' DESC, d.id DESC LIMIT 100`, [a.distributorId]);
  else throw forbidden();
  res.json({ disputes: rows.map((d) => ({
    id: d.id, ledger_id: d.ledger_id, status: d.status, reason: d.reason, resolution_note: d.resolution_note, created_at: d.created_at,
    type: d.type, amount: fromPaise(Number(d.amount_paise)), entry_at: d.entry_at, shop_name: d.shop_name, business_name: d.business_name,
  })) });
}));

// Distributor answers a dispute: reverse the entry (balance corrected) or reject it with an explanation.
ledgerRouter.post('/disputes/:id/resolve', authenticate, requireRole('distributor'), asyncHandler(async (req, res) => {
  const id = idParam(req);
  const b = z.object({ action: z.enum(['reverse', 'reject']), note: z.string().trim().max(500).optional() }).parse(req.body);
  if (b.action === 'reject' && !b.note) throw new AppError(400, 'VALIDATION', 'Explain why the entry stands');
  const d = await q1<any>(pool, 'SELECT * FROM ledger_disputes WHERE id = ? AND distributor_id = ?', [id, req.auth!.userId]);
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Dispute not found');
  if (d.status !== 'open') throw new AppError(409, 'ALREADY_RESOLVED', `Dispute is already ${d.status}`);

  if (b.action === 'reverse') {
    const orig = await q1<any>(pool, 'SELECT * FROM ledger_transactions WHERE id = ?', [d.ledger_id]);
    try {
      await safePost({
        distributorId: d.distributor_id, retailerId: d.retailer_id, type: 'reversal', amountPaise: Number(orig.amount_paise), reversalOf: orig.id,
        createdBy: req.auth!.userId, idempotencyKey: `dispute:${d.id}`, notes: `Dispute #${d.id} accepted`,
      });
    } catch (e: any) {
      if (e?.code !== 'ALREADY_REVERSED') throw e; // already reversed by hand: still resolve the dispute
    }
  }
  await exec(pool, "UPDATE ledger_disputes SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'open'", [
    b.action === 'reverse' ? 'resolved' : 'rejected', b.note ?? null, req.auth!.userId, d.id,
  ]);
  await audit(req.auth!.userId, `ledger.dispute_${b.action}`, 'ledger', d.ledger_id, { dispute_id: d.id });
  notifyUsers([d.retailer_id], b.action === 'reverse' ? 'Dispute accepted' : 'Dispute answered', b.action === 'reverse' ? 'The entry was reversed in your khata.' : (b.note ?? '').slice(0, 100), { type: 'payment' });
  res.json({ dispute: { id: d.id, status: b.action === 'reverse' ? 'resolved' : 'rejected' } });
}));
