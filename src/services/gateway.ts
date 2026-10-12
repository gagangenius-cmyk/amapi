import crypto from 'crypto';

/**
 * Payment gateway behind a small interface. The retailer pays on the gateway's hosted page (card, netbanking, UPI), so the app
 * needs no payment SDK and card details never touch AAYME. The gateway then calls our webhook, and only that signed call
 * (never the app) moves money in the khata.
 */
export interface PaymentLink { id: string; url: string }
export type GatewayEvent =
  | { kind: 'paid'; eventId: string; linkId: string; referenceId: string | null; paymentId: string | null; amountPaise: number }
  | { kind: 'failed'; eventId: string; linkId: string; referenceId: string | null }
  | { kind: 'ignored'; eventId: string };

export interface Gateway {
  name: string;
  createPaymentLink(o: { amountPaise: number; referenceId: string; description: string; customer: { name: string; phone: string; email?: string | null } }): Promise<PaymentLink>;
  verifyWebhook(raw: Buffer, signature: string | undefined): boolean;
  parseWebhook(body: any, headers: Record<string, string | string[] | undefined>): GatewayEvent;
}

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function razorpay(cfg: { keyId: string; keySecret: string; webhookSecret: string; baseUrl?: string; callbackUrl?: string }): Gateway {
  const base = cfg.baseUrl ?? 'https://api.razorpay.com';
  return {
    name: 'razorpay',
    async createPaymentLink(o) {
      const res = await fetch(`${base}/v1/payment_links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64') },
        body: JSON.stringify({
          amount: o.amountPaise, currency: 'INR', accept_partial: false, reference_id: o.referenceId, description: o.description.slice(0, 250),
          customer: { name: o.customer.name, contact: o.customer.phone.length === 10 ? `+91${o.customer.phone}` : o.customer.phone, ...(o.customer.email && { email: o.customer.email }) },
          notify: { sms: false, email: false }, reminder_enable: false,
          ...(cfg.callbackUrl && { callback_url: cfg.callbackUrl, callback_method: 'get' }),
        }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j.id || !j.short_url) throw new Error(`Razorpay: ${j?.error?.description ?? res.status}`);
      return { id: j.id, url: j.short_url };
    },
    verifyWebhook(raw, signature) {
      if (!signature) return false;
      return safeEqualHex(crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex'), signature);
    },
    parseWebhook(body, headers) {
      const eventId = String(headers['x-razorpay-event-id'] ?? '');
      const link = body?.payload?.payment_link?.entity;
      const pay = body?.payload?.payment?.entity;
      if (!eventId || !link?.id) return { kind: 'ignored', eventId };
      if (body.event === 'payment_link.paid') return { kind: 'paid', eventId, linkId: link.id, referenceId: link.reference_id ?? null, paymentId: pay?.id ?? null, amountPaise: Number(pay?.amount ?? link.amount_paid ?? link.amount) };
      if (body.event === 'payment_link.expired' || body.event === 'payment_link.cancelled') return { kind: 'failed', eventId, linkId: link.id, referenceId: link.reference_id ?? null };
      return { kind: 'ignored', eventId };
    },
  };
}

let override: Gateway | null | undefined;
/** Tests plug in their own gateway. */
export const setGateway = (g: Gateway | null | undefined) => { override = g; };

export function getGateway(): Gateway | null {
  if (override !== undefined) return override;
  if (process.env.GATEWAY === 'razorpay' && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET) {
    return razorpay({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET, baseUrl: process.env.RAZORPAY_BASE_URL, callbackUrl: process.env.PAYMENT_CALLBACK_URL });
  }
  return null;
}
