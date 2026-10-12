import { Conn, exec, q, q1 } from '../../db/pool';
import { AppError, notFound } from '../../utils/errors';

export type LedgerType = 'invoice' | 'payment_cash' | 'payment_online' | 'credit_note' | 'debit_note' | 'reversal';

/** Sign of delta for each type: +1 increases retailer's due, -1 decreases it. */
const SIGN: Record<Exclude<LedgerType, 'reversal'>, 1 | -1> = {
  invoice: 1,
  debit_note: 1,
  payment_cash: -1,
  payment_online: -1,
  credit_note: -1,
};

export const NOTES = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export function validateDenominations(d: Record<string, number> | undefined, amountPaise: number) {
  if (!d || Object.keys(d).length === 0) throw new AppError(400, 'DENOMINATIONS_REQUIRED', 'Cash payments need cash_denominations');
  let sum = 0;
  for (const [note, count] of Object.entries(d)) {
    if (!(NOTES as readonly number[]).includes(Number(note))) throw new AppError(400, 'BAD_DENOMINATION', `Unsupported note: ${note}`);
    if (!Number.isInteger(count) || count < 0) throw new AppError(400, 'BAD_DENOMINATION', `Invalid count for ${note}`);
    sum += Number(note) * count * 100;
  }
  if (sum !== amountPaise)
    throw new AppError(400, 'DENOMINATION_MISMATCH', 'Denominations do not add up to the amount', { counted_paise: sum, amount_paise: amountPaise });
}

export interface PostInput {
  distributorId: number;
  retailerId: number;
  type: LedgerType;
  amountPaise: number;
  createdBy: number;
  idempotencyKey: string;
  orderId?: number | null;
  paymentMode?: string | null;
  denominations?: Record<string, number>;
  gatewayEventId?: string | null;
  reversalOf?: number | null;
  notes?: string | null;
}

/**
 * Append one ledger row and move the running balance. MUST run inside a transaction:
 * the relation row is locked (FOR UPDATE) so concurrent postings for the same pair serialize.
 * Replays of the same (createdBy, idempotencyKey) return the original row.
 */
export async function postLedger(c: Conn, i: PostInput) {
  if (!Number.isInteger(i.amountPaise) || i.amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Amount must be positive');

  const existing = await q1<any>(c, 'SELECT * FROM ledger_transactions WHERE created_by = ? AND idempotency_key = ?', [i.createdBy, i.idempotencyKey]);
  if (existing) {
    if (existing.distributor_id !== i.distributorId || existing.retailer_id !== i.retailerId || Number(existing.amount_paise) !== i.amountPaise)
      throw new AppError(422, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
    return { row: existing, replayed: true };
  }

  const rel = await q1<any>(c, "SELECT id, balance_due_paise FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active' FOR UPDATE", [
    i.retailerId, i.distributorId,
  ]);
  if (!rel) throw notFound('Retailer relation');

  let sign: 1 | -1;
  if (i.type === 'reversal') {
    const orig = await q1<any>(c, 'SELECT * FROM ledger_transactions WHERE id = ? AND distributor_id = ? AND retailer_id = ?', [i.reversalOf, i.distributorId, i.retailerId]);
    if (!orig) throw notFound('Original transaction');
    if (orig.type === 'reversal') throw new AppError(409, 'ALREADY_REVERSAL', 'Cannot reverse a reversal');
    if (Number(orig.amount_paise) !== i.amountPaise) throw new AppError(400, 'BAD_AMOUNT', 'Reversal amount must equal the original');
    sign = Number(orig.delta_paise) > 0 ? -1 : 1;
  } else {
    sign = SIGN[i.type];
  }

  const delta = sign * i.amountPaise;
  const balanceAfter = Number(rel.balance_due_paise) + delta;
  const res = await exec(
    c,
    `INSERT INTO ledger_transactions
     (distributor_id, retailer_id, order_id, type, amount_paise, delta_paise, balance_after_paise, payment_mode,
      cash_denominations, gateway_event_id, reversal_of, notes, created_by, idempotency_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      i.distributorId, i.retailerId, i.orderId ?? null, i.type, i.amountPaise, delta, balanceAfter, i.paymentMode ?? null,
      i.denominations ? JSON.stringify(i.denominations) : null, i.gatewayEventId ?? null, i.reversalOf ?? null, i.notes ?? null,
      i.createdBy, i.idempotencyKey,
    ],
  );
  await exec(c, 'UPDATE retailer_distributor_relations SET balance_due_paise = ? WHERE id = ?', [balanceAfter, rel.id]);
  const row = await q1<any>(c, 'SELECT * FROM ledger_transactions WHERE id = ?', [res.insertId]);
  return { row, replayed: false };
}

export async function statement(c: Conn, distributorId: number, retailerId: number, before?: number, limit = 50) {
  // One consistent snapshot, so the balance and the listed rows can never disagree while postings are happening.
  const conn = 'getConnection' in c ? await c.getConnection() : c;
  try {
    if (conn !== c) await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const rel = await q1<any>(conn, "SELECT balance_due_paise FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = 'active'", [retailerId, distributorId]);
    if (!rel) throw notFound('Relation');
    const rows = await q<any>(
      conn,
      `SELECT l.*, d.id AS dispute_id, d.status AS dispute_status, d.reason AS dispute_reason
       FROM ledger_transactions l LEFT JOIN ledger_disputes d ON d.ledger_id = l.id
       WHERE l.distributor_id = ? AND l.retailer_id = ? ${before ? 'AND l.id < ?' : ''} ORDER BY l.id DESC LIMIT ?`,
      before ? [distributorId, retailerId, before, limit] : [distributorId, retailerId, limit],
    );
    return { balance_due_paise: Number(rel.balance_due_paise), rows };
  } finally {
    if (conn !== c) { await (conn as any).query('COMMIT').catch(() => {}); (conn as any).release(); }
  }
}
