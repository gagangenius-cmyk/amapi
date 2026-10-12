import { Router } from 'express';

type Op = [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, summary: string, opts?: { auth?: boolean; idem?: boolean; roles?: string }];

// One line per endpoint keeps the docs next to the code and easy to keep in sync.
const OPS: Op[] = [
  ['post', '/auth/register', 'Register a retailer or distributor', { auth: false }],
  ['post', '/auth/login', 'Phone + password login', { auth: false }],
  ['post', '/auth/refresh', 'Rotate refresh token', { auth: false }],
  ['post', '/auth/logout', 'Revoke all refresh tokens'],
  ['post', '/auth/otp/request', 'Email a 6-digit code (identifier = email or phone; purpose: login | reset)', { auth: false }],
  ['post', '/auth/otp/verify', 'Verify code: login, or reset password with new_password', { auth: false }],
  ['get', '/me', 'My profile and email status'],
  ['post', '/auth/email/send-verification', 'Email a code to confirm my address'],
  ['post', '/auth/email/verify', 'Confirm my address with the code'],
  ['put', '/me/email', 'Set the email that receives OTP codes (needs password)'],
  ['get', '/me/export', 'Download all data held about me'],
  ['delete', '/me', 'Delete (anonymise) my account (needs password)'],
  ['get', '/reports/summary', 'Sales / collections / outstanding summary', { roles: 'distributor' }],
  ['get', '/orders/{id}/invoice-link', 'Signed 10-minute link to the GST invoice'],
  ['post', '/devices', 'Register an Expo push token'],
  ['delete', '/devices', 'Unregister a push token'],
  ['get', '/distributor/me', 'Own business profile, permissions, subscription', { roles: 'distributor, employee' }],
  ['put', '/distributor/me', 'Update business name, GST, bank/UPI details', { roles: 'distributor' }],
  ['get', '/distributor/pincodes', 'Pincodes served', { roles: 'distributor, employee' }],
  ['put', '/distributor/pincodes', 'Replace served pincodes', { roles: 'distributor' }],
  ['get', '/distributor/employees', 'List delivery employees', { roles: 'distributor' }],
  ['post', '/distributor/employees', 'Create a delivery employee', { roles: 'distributor' }],
  ['get', '/distributor/retailers', 'Retailers linked to this distributor with balances', { roles: 'distributor, employee' }],
  ['post', '/distributor/retailers', 'Ask a retailer (by phone) to become a customer; they must accept', { roles: 'distributor' }],
  ['delete', '/distributor/retailers/{retailerId}', 'Withdraw a pending request', { roles: 'distributor' }],
  ['put', '/distributor/{id}/admin', 'Set permissions / extend subscription / commission', { roles: 'admin' }],
  ['get', '/admin/distributors', 'All distributors with subscription status', { roles: 'admin' }],
  ['get', '/admin/commissions', 'Commission owed on delivered out-of-hierarchy orders', { roles: 'admin' }],
  ['get', '/catalog', 'Own catalog: q, category, status (all|active|low|out|hidden), limit, offset; returns summary counts and categories', { roles: 'distributor, employee' }],
  ['get', '/catalog/{id}', 'One product with stock and price history', { roles: 'distributor, employee' }],
  ['post', '/catalog', 'Add product (details, MRP, quantity breaks, opening stock)', { roles: 'distributor' }],
  ['patch', '/catalog/{id}', 'Edit details, price, quantity breaks (not stock)', { roles: 'distributor' }],
  ['post', '/catalog/{id}/stock', 'Add/remove stock (delta) or record a count (set_to + expected)', { roles: 'distributor' }],
  ['post', '/catalog/{id}/duplicate', 'Copy a product as a hidden draft', { roles: 'distributor' }],
  ['delete', '/catalog/{id}', 'Soft-delete product', { roles: 'distributor' }],
  ['post', '/catalog/bulk/apply', 'Bulk: activate, deactivate, delete, price_percent, stock_add, set_category', { roles: 'distributor' }],
  ['post', '/catalog/import/rows', 'Import up to 500 rows; optional upsert by SKU; reports bad rows by number', { roles: 'distributor' }],
  ['get', '/retailer/stores', 'Pinned primary distributor (+catalog) and other distributors for a pincode', { roles: 'retailer' }],
  ['get', '/retailer/stores/{distributorId}/products', 'Catalog of any active distributor', { roles: 'retailer' }],
  ['get', '/retailer/distributors', 'Own khata accounts with balances', { roles: 'retailer' }],
  ['put', '/retailer/primary', 'Pin a distributor as primary', { roles: 'retailer' }],
  ['get', '/retailer/link-requests', 'Suppliers asking to link with this retailer', { roles: 'retailer' }],
  ['post', '/retailer/link-requests/{distributorId}/accept', 'Accept a supplier request', { roles: 'retailer' }],
  ['post', '/retailer/link-requests/{distributorId}/decline', 'Decline a supplier request', { roles: 'retailer' }],
  ['post', '/orders', 'Place an order', { idem: true, roles: 'retailer' }],
  ['get', '/orders', 'List orders scoped to the caller'],
  ['get', '/orders/{id}', 'Order with items and event history'],
  ['post', '/orders/{id}/transition', 'Move order to next status (state machine enforced)'],
  ['get', '/collections/receivables', 'Who owes what, aged into not-due / 1-30 / 31-60 / 61-90 / 90+ days (FIFO from the ledger)', { roles: 'distributor' }],
  ['put', '/collections/terms/{retailerId}', 'Set credit limit (null = none) and credit days for one retailer', { roles: 'distributor' }],
  ['post', '/collections/remind/{retailerId}', 'Send a payment reminder (max one per 24 h per retailer)', { roles: 'distributor' }],
  ['post', '/returns', 'Ask to return part of a delivered order', { idem: true, roles: 'retailer' }],
  ['get', '/returns', 'Returns for the caller (filter by status / order_id)'],
  ['post', '/returns/{id}/resolve', 'Approve (credit note + optional restock) or reject a return', { roles: 'distributor' }],
  ['post', '/orders/{id}/assign', 'Assign / reassign delivery employee', { roles: 'distributor' }],
  ['post', '/ledger/transaction', 'Record cash payment (with note counts), credit or debit note', { idem: true, roles: 'distributor, employee' }],
  ['post', '/ledger/transaction/{id}/reverse', 'Reverse a ledger entry once', { idem: true, roles: 'distributor' }],
  ['get', '/ledger/statement', 'Balance + paginated transactions'],
  ['post', '/ledger/transaction/{id}/dispute', 'Retailer contests a khata entry', { roles: 'retailer' }],
  ['get', '/ledger/disputes', 'Disputes (retailer: own; distributor: against them)'],
  ['post', '/ledger/disputes/{id}/resolve', 'Distributor reverses the entry or rejects with a note', { roles: 'distributor' }],
  ['post', '/ledger/webhook/payment', 'Gateway webhook (x-webhook-secret)', { auth: false }],
  ['get', '/payments/pay-info/{distributorId}', 'UPI id and upi:// link to pay a distributor', { roles: 'retailer' }],
  ['post', '/payments', 'Report a UPI payment with UTR (pending until confirmed)', { idem: true, roles: 'retailer' }],
  ['get', '/payments', 'Own payments (retailer) or all incoming (distributor)'],
  ['post', '/payments/{id}/confirm', 'Confirm payment and post to ledger', { roles: 'distributor' }],
  ['post', '/payments/{id}/reject', 'Reject payment', { roles: 'distributor' }],
  ['get', '/chat/conversations', 'Conversations with last message and unread count'],
  ['get', '/chat/messages', 'Message history (distributor_id or retailer_id, before, limit)'],
  ['post', '/chat/messages', 'Send message over REST (client_id for idempotency)'],
];

function buildSpec() {
  const paths: Record<string, any> = {};
  for (const [method, path, summary, o = {}] of OPS) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'integer' } }));
    if (o.idem) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 80 } } as any);
    (paths[path] ??= {})[method] = {
      summary: o.roles ? `${summary} [${o.roles}]` : summary,
      parameters: params,
      ...(o.auth === false ? { security: [] } : {}),
      responses: { '200': { description: 'OK' }, '4XX': { description: 'Error: {error:{code,message,details}}' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'AAYME API', version: '0.2.0', description: 'Amounts are decimal strings in rupees (e.g. "5000.00"). Writes that move money need an Idempotency-Key header.' },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: [{ bearer: [] }],
    paths,
  };
}

export const docsRouter = Router();
const spec = buildSpec();
docsRouter.get('/openapi.json', (_req, res) => res.json(spec));
docsRouter.get('/docs', (_req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data:");
  res.type('html').send(`<!doctype html><html><head><title>AAYME API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#ui'})</script></body></html>`);
});
