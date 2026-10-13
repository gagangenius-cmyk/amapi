import { Router } from 'express';
import { exec, pool, q1, withTx } from '../../db/pool';
import { getGateway } from '../../services/gateway';
import { notifyUsers } from '../../services/notify';
import { audit } from '../../utils/audit';
import { logger } from '../../utils/logger';
import { fromPaise } from '../../utils/money';
import { postLedger } from '../ledger/ledger.service';
import { afterConfirm, confirmSubscriptionPayment } from '../subscription/subscription.service';
import { afterOnboarding, completeOnboarding } from '../onboarding/onboarding.service';

/**
 * Gateway callbacks. No login here: the signature over the raw body is the only credential, checked before anything else.
 * We answer 200 to every correctly signed event (even ones we ignore) so the gateway does not retry forever, and make
 * every handler safe to run twice.
 */
export const paymentWebhookRouter = Router();

paymentWebhookRouter.post('/', async (req, res) => {
  const gw = getGateway();
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!gw || !raw || !gw.verifyWebhook(raw, req.header('x-razorpay-signature'))) return void res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Signature check failed' } });
  try {
    const ev = gw.parseWebhook(req.body, req.headers);
    if (ev.kind === 'ignored') return void res.json({ ok: true, ignored: true });

    const out = await withTx(async (c) => {
      const p = await q1<any>(c, 'SELECT * FROM payment_intents WHERE gateway_ref = ? FOR UPDATE', [ev.linkId]);
      if (!p) {
        // not a retailer's payment: maybe a distributor paying for a subscription plan
        const sp = await q1<any>(c, 'SELECT * FROM subscription_payments WHERE gateway_ref = ? FOR UPDATE', [ev.linkId]);
        if (!sp) {
          // or a distributor being onboarded by a company employee: the account is created only now, when the fee has arrived
          const ob = await q1<any>(c, 'SELECT * FROM onboarding_requests WHERE gateway_ref = ? FOR UPDATE', [ev.linkId]);
          if (!ob) return { result: 'unknown_reference' as const };
          if (ob.status !== 'awaiting_payment') return { result: 'already_settled' as const };
          if (ev.kind === 'failed') {
            await exec(c, "UPDATE onboarding_requests SET status = 'failed', error = 'The payment link expired or was cancelled', decided_at = UTC_TIMESTAMP() WHERE id = ?", [ob.id]);
            return { result: 'failed' as const };
          }
          if (ev.amountPaise !== Number(ob.amount_paise)) {
            await exec(c, "UPDATE onboarding_requests SET status = 'failed', gateway_payment_id = ?, error = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?",
              [ev.paymentId, `Paid ${fromPaise(ev.amountPaise)} but ${fromPaise(Number(ob.amount_paise))} was due. Refund it or start again.`, ob.id]);
            return { result: 'amount_mismatch' as const, ob, paid: ev.amountPaise };
          }
          const done = await completeOnboarding(c, ob.id, { decidedBy: null, gatewayPaymentId: ev.paymentId });
          return { result: 'onboarding_completed' as const, done };
        }
        if (sp.status !== 'pending') return { result: 'already_settled' as const };
        if (ev.kind === 'failed') { await exec(c, "UPDATE subscription_payments SET status = 'failed', decided_at = UTC_TIMESTAMP() WHERE id = ?", [sp.id]); return { result: 'failed' as const }; }
        if (ev.amountPaise !== Number(sp.amount_paise)) { await exec(c, "UPDATE subscription_payments SET status = 'failed', gateway_payment_id = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?", [ev.paymentId, sp.id]); return { result: 'amount_mismatch' as const, paid: ev.amountPaise, sub: sp }; }
        await exec(c, 'UPDATE subscription_payments SET gateway_payment_id = ? WHERE id = ?', [ev.paymentId, sp.id]);
        const done = await confirmSubscriptionPayment(c, sp.id, null);
        return { result: 'subscription_confirmed' as const, sub: sp, ends_at: done.ends_at };
      }
      if (p.status !== 'pending') return { result: 'already_settled' as const, p };
      if (ev.kind === 'failed') {
        await exec(c, "UPDATE payment_intents SET status = 'failed', decided_at = UTC_TIMESTAMP() WHERE id = ?", [p.id]);
        return { result: 'failed' as const, p };
      }
      // The amount actually paid must be exactly what we asked for; anything else is held for a human instead of guessed at.
      if (ev.amountPaise !== Number(p.amount_paise)) {
        await exec(c, "UPDATE payment_intents SET status = 'failed', gateway_payment_id = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?", [ev.paymentId, p.id]);
        return { result: 'amount_mismatch' as const, p, paid: ev.amountPaise };
      }
      await postLedger(c, {
        distributorId: p.distributor_id, retailerId: p.retailer_id, type: 'payment_online', amountPaise: Number(p.amount_paise),
        createdBy: p.retailer_id, idempotencyKey: `gwpay:${p.id}`, gatewayEventId: ev.eventId, paymentMode: 'gateway', notes: `Online payment ${ev.paymentId ?? ev.linkId}`,
      });
      await exec(c, "UPDATE payment_intents SET status = 'confirmed', gateway_payment_id = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?", [ev.paymentId, p.id]);
      return { result: 'confirmed' as const, p };
    });

    if (out.result === 'onboarding_completed') {
      await afterOnboarding(out.done, null);
    } else if (out.result === 'subscription_confirmed') {
      await afterConfirm(out.sub.id, out.sub.distributor_id, out.ends_at, out.sub.plan_name, null);
    } else if (out.result === 'confirmed') {
      const amt = fromPaise(Number(out.p.amount_paise));
      await audit(null, 'payment.gateway_confirmed', 'payment', out.p.id, { amount_paise: Number(out.p.amount_paise), gateway: gw.name });
      notifyUsers([out.p.retailer_id], 'Payment received', `₹${amt} paid online. Thank you!`, { type: 'payment', id: out.p.id });
      notifyUsers([out.p.distributor_id], 'Online payment received', `₹${amt} was paid into your khata.`, { type: 'payment', id: out.p.id });
    } else if (out.result === 'amount_mismatch') {
      const row = (out as any).p ?? (out as any).sub ?? (out as any).ob;
      await audit(null, 'payment.gateway_amount_mismatch', 'payment', row.id, { expected_paise: Number(row.amount_paise), paid_paise: out.paid, kind: (out as any).ob ? 'onboarding' : (out as any).sub ? 'subscription' : 'retailer' });
      logger.error({ paymentId: row.id, expected: Number(row.amount_paise), paid: out.paid }, 'gateway amount mismatch: needs manual review');
    } else if (out.result === 'unknown_reference') {
      logger.warn({ linkId: ev.linkId }, 'gateway event for an unknown payment link');
    }
    res.json({ ok: true, result: out.result });
  } catch (err) {
    logger.error({ err }, 'gateway webhook failed');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not process the event; the gateway may retry' } });   // 5xx => gateway retries, handlers are idempotent
  }
});
