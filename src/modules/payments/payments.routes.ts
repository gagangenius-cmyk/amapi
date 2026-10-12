import { Router } from 'express';
import { z } from 'zod';
import { exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, idempotencyKey, requireRole } from '../../middleware/auth';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { idParam } from '../../utils/http';
import { fromPaise, toPaise } from '../../utils/money';
import { notifyUsers } from '../../services/notify';
import { assertPermission, assertSubscriptionActive, loadDistributor } from '../distributors/subscription';
import { postLedger } from '../ledger/ledger.service';
import { getGateway } from '../../services/gateway';

/**
 * Online payment via UPI, no gateway fees: the retailer pays the distributor's UPI id from any UPI app,
 * then submits the UTR. The distributor confirms it (checking their bank app) and only then does the
 * ledger move. Unconfirmed payments never touch the balance.
 */
export const paymentRouter = Router();
paymentRouter.use(authenticate);

const present = (p: any) => ({
  id: p.id, distributor_id: p.distributor_id, retailer_id: p.retailer_id, amount: fromPaise(Number(p.amount_paise)), utr: p.utr,
  status: p.status, method: p.method ?? 'upi', checkout_url: p.status === 'pending' ? p.checkout_url ?? null : null, created_at: p.created_at, decided_at: p.decided_at,
  ...(p.shop_name && { shop_name: p.shop_name }), ...(p.business_name && { business_name: p.business_name }),
});

// Which ways of paying exist right now (the app shows the buttons accordingly).
paymentRouter.get('/methods', asyncHandler(async (_req, res) => { res.json({ upi: true, gateway: !!getGateway() }); }));

// Pay online (card / netbanking / UPI) on the gateway's hosted page. Returns the link to open; the khata moves only when the
// gateway's signed webhook says the money arrived.
paymentRouter.post('/gateway/link', requireRole('retailer'), asyncHandler(async (req, res) => {
  const gw = getGateway();
  if (!gw) throw new AppError(501, 'GATEWAY_NOT_CONFIGURED', 'Online payments are not set up yet. Pay by UPI and enter the UTR instead.');
  const b = z.object({ distributor_id: z.number().int().positive(), amount: z.union([z.string(), z.number()]) }).parse(req.body);
  const key = idempotencyKey(req);
  const retailerId = req.auth!.userId;
  const amountPaise = toPaise(b.amount);
  if (amountPaise < 100) throw new AppError(400, 'BAD_AMOUNT', 'The minimum online payment is ₹1');
  if (amountPaise > 50_000_000) throw new AppError(400, 'BAD_AMOUNT', 'The maximum online payment is ₹5,00,000. Pay larger amounts in parts.');
  await assertSubscriptionActive(pool, b.distributor_id);
  await assertPermission(pool, b.distributor_id, 'online_payments');
  if (!(await q1(pool, 'SELECT 1 FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = "active"', [retailerId, b.distributor_id]))) throw notFound('Distributor');

  const dup = await q1<any>(pool, 'SELECT * FROM payment_intents WHERE retailer_id = ? AND idempotency_key = ?', [retailerId, key]);
  if (dup) {
    if (dup.method !== 'gateway' || Number(dup.amount_paise) !== amountPaise || dup.distributor_id !== b.distributor_id) throw new AppError(422, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
    return void res.status(200).json({ replayed: true, payment: present(dup), checkout_url: dup.checkout_url });
  }
  // The intent exists BEFORE the link, so the webhook can always find it.
  const ins = await exec(pool, "INSERT INTO payment_intents (distributor_id, retailer_id, amount_paise, utr, idempotency_key, method) VALUES (?,?,?,?,?,'gateway')", [b.distributor_id, retailerId, amountPaise, `GW${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`, key]);
  const me = (await q1<any>(pool, 'SELECT name, phone, email FROM users WHERE id = ?', [retailerId]))!;
  const dist = await loadDistributor(pool, b.distributor_id);
  try {
    const link = await gw.createPaymentLink({ amountPaise, referenceId: `pi_${ins.insertId}`, description: `Payment to ${dist.business_name}`, customer: { name: me.name, phone: me.phone, email: me.email } });
    await exec(pool, "UPDATE payment_intents SET gateway_ref = ?, checkout_url = ?, utr = ? WHERE id = ?", [link.id, link.url, link.id.slice(0, 30), ins.insertId]);
    const row = await q1<any>(pool, 'SELECT * FROM payment_intents WHERE id = ?', [ins.insertId]);
    res.status(201).json({ replayed: false, payment: present(row), checkout_url: link.url });
  } catch (err: any) {
    await exec(pool, "UPDATE payment_intents SET status = 'failed' WHERE id = ?", [ins.insertId]);
    throw new AppError(502, 'GATEWAY_ERROR', 'The payment service did not respond. Nothing was charged. Please try again.', { reason: String(err?.message ?? err).slice(0, 120) });
  }
}));

// What a retailer needs to pay a distributor: UPI id, payee name and a ready-to-open upi:// link.
paymentRouter.get('/pay-info/:distributorId', requireRole('retailer'), asyncHandler(async (req, res) => {
  const id = idParam(req, 'distributorId');
  if (!(await q1(pool, 'SELECT 1 FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = "active"', [req.auth!.userId, id]))) throw notFound('Distributor');
  const d = await loadDistributor(pool, id);
  if (!d.permissions.online_payments) throw new AppError(403, 'FEATURE_OFF', 'This distributor does not take online payments. Pay in cash.');
  const bank = d.bank_account_details ? JSON.parse(d.bank_account_details) : null;
  if (!bank?.upi_id) throw new AppError(409, 'NO_UPI', 'This distributor has not set up online payments');
  const amount = req.query.amount ? fromPaise(toPaise(String(req.query.amount))) : undefined;
  const params = new URLSearchParams({ pa: bank.upi_id, pn: d.business_name, cu: 'INR', ...(amount && { am: amount }) });
  res.json({ upi_id: bank.upi_id, payee: d.business_name, account_name: bank.account_name, upi_uri: `upi://pay?${params.toString()}` });
}));

paymentRouter.post('/', requireRole('retailer'), asyncHandler(async (req, res) => {
  const b = z.object({
    distributor_id: z.number().int().positive(), amount: z.union([z.string(), z.number()]),
    utr: z.string().regex(/^[A-Za-z0-9]{8,30}$/, 'UTR must be 8-30 letters/digits'),
  }).parse(req.body);
  const key = idempotencyKey(req);
  const retailerId = req.auth!.userId;
  const amountPaise = toPaise(b.amount);
  if (amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Amount must be positive');
  await assertSubscriptionActive(pool, b.distributor_id);
  await assertPermission(pool, b.distributor_id, 'online_payments');
  if (!(await q1(pool, 'SELECT 1 FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ? AND status = "active"', [retailerId, b.distributor_id]))) throw notFound('Distributor');

  let replayed = false;
  let row: any;
  try {
    const r = await exec(pool, 'INSERT INTO payment_intents (distributor_id, retailer_id, amount_paise, utr, idempotency_key) VALUES (?,?,?,?,?)', [
      b.distributor_id, retailerId, amountPaise, b.utr.toUpperCase(), key,
    ]);
    row = await q1(pool, 'SELECT * FROM payment_intents WHERE id = ?', [r.insertId]);
  } catch (e: any) {
    if (e?.code !== 'ER_DUP_ENTRY') throw e;
    row = await q1<any>(pool, 'SELECT * FROM payment_intents WHERE retailer_id = ? AND idempotency_key = ?', [retailerId, key]);
    if (!row) throw new AppError(409, 'UTR_USED', 'This UTR was already submitted'); // same UTR, different key
    replayed = true;
  }
  if (!replayed) {
    notifyUsers([b.distributor_id], 'Payment to confirm', `₹${fromPaise(amountPaise)} reported via UPI (UTR ${b.utr.toUpperCase()})`, { type: 'payment', id: row.id });
  }
  res.status(replayed ? 200 : 201).json({ replayed, payment: present(row) });
}));

// Retailer: own payments. Distributor: all payments, pending first.
paymentRouter.get('/', asyncHandler(async (req, res) => {
  const a = req.auth!;
  if (a.role === 'retailer') {
    const rows = await q<any>(pool, `SELECT p.*, dp.business_name FROM payment_intents p JOIN distributor_profiles dp ON dp.user_id = p.distributor_id WHERE p.retailer_id = ? ORDER BY p.id DESC LIMIT 100`, [a.userId]);
    return res.json({ payments: rows.map(present) });
  }
  if (a.role === 'distributor') {
    const rows = await q<any>(pool, `SELECT p.*, rp.shop_name FROM payment_intents p JOIN retailer_profiles rp ON rp.user_id = p.retailer_id WHERE p.distributor_id = ? ORDER BY p.status = 'pending' DESC, p.id DESC LIMIT 100`, [a.userId]);
    return res.json({ payments: rows.map(present) });
  }
  throw new AppError(403, 'FORBIDDEN', 'Forbidden');
}));

async function decide(req: any, res: any, decision: 'confirmed' | 'rejected') {
  const id = idParam(req);
  const out = await withTx(async (c) => {
    const p = await q1<any>(c, 'SELECT * FROM payment_intents WHERE id = ? AND distributor_id = ? FOR UPDATE', [id, req.auth!.userId]);
    if (!p) throw notFound('Payment');
    if (p.method === 'gateway') throw new AppError(409, 'GATEWAY_MANAGED', 'Online payments are confirmed automatically by the payment gateway');
    if (p.status !== 'pending') {
      if (p.status === decision) return { p, replayed: true };
      throw new AppError(409, 'ALREADY_DECIDED', `Payment already ${p.status}`);
    }
    if (decision === 'confirmed') {
      await assertSubscriptionActive(c, p.distributor_id);
      await assertPermission(c, p.distributor_id, 'khatabook_enabled');
      await postLedger(c, {
        distributorId: p.distributor_id, retailerId: p.retailer_id, type: 'payment_online', amountPaise: Number(p.amount_paise),
        createdBy: req.auth!.userId, idempotencyKey: `pay:${p.id}`, paymentMode: 'upi', notes: `UPI UTR ${p.utr}`,
      });
    }
    await exec(c, 'UPDATE payment_intents SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?', [decision, req.auth!.userId, p.id]);
    return { p: { ...p, status: decision }, replayed: false };
  });
  if (!out.replayed) await audit(req.auth!.userId, `payment.${decision}`, 'payment', id, { amount_paise: Number(out.p.amount_paise), utr: out.p.utr });
  if (!out.replayed) notifyUsers([out.p.retailer_id], decision === 'confirmed' ? 'Payment confirmed' : 'Payment rejected', `₹${fromPaise(Number(out.p.amount_paise))} (UTR ${out.p.utr})`, { type: 'payment', id });
  res.json({ replayed: out.replayed, payment: present(out.p) });
}

paymentRouter.post('/:id/confirm', requireRole('distributor'), asyncHandler((req, res) => decide(req, res, 'confirmed')));
paymentRouter.post('/:id/reject', requireRole('distributor'), asyncHandler((req, res) => decide(req, res, 'rejected')));
