# AAYME Backend

Node.js + TypeScript + Express + MySQL/MariaDB. Money is stored as integer **paise** (BIGINT) and exposed in the API as decimal strings (`"5000.00"`).

## Run
```
cp .env.example .env        # set DB_* and JWT_SECRET
npm run migrate             # creates schema in DB_NAME
npm run dev                 # http://localhost:4000
npm test                    # uses DB "aymee_test" (wiped on each run)
npm run create-admin -- 9999999999 'a-strong-password'
```
Set `WEBHOOK_SECRET` to enable `POST /api/v1/ledger/webhook/payment` (header `x-webhook-secret`).

## Endpoints (all under `/api/v1`)
| Area | Endpoint |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` |
| Distributor | `GET/PUT /distributor/me`, `PUT/GET /distributor/pincodes`, `POST/GET /distributor/employees`, `POST/GET /distributor/retailers`, `PUT /distributor/:id/admin` (admin: permissions, extend subscription, commission) |
| Catalog | `POST/GET /catalog`, `PATCH/DELETE /catalog/:id` |
| Retailer | `GET /retailer/stores?pincode=`, `GET /retailer/stores/:id/products`, `PUT /retailer/primary` |
| Orders | `POST /orders` (Idempotency-Key), `GET /orders`, `GET /orders/:id`, `POST /orders/:id/transition`, `POST /orders/:id/assign` |
| Payments (UPI) | `GET /payments/pay-info/:distributorId`, `POST /payments` (Idempotency-Key, pending until confirmed), `GET /payments`, `POST /payments/:id/confirm`, `POST /payments/:id/reject` |
| Chat | `GET /chat/conversations`, `GET/POST /chat/messages`; Socket.io on the same port (`auth: {token}`, event `message:new`, `message:send`) |
| Other | `POST /auth/otp/request`, `POST /auth/otp/verify` (login/reset), `POST/DELETE /devices` (push token), `GET /admin/distributors`, `GET /admin/commissions`, `/docs` (Swagger UI), `/openapi.json` |
| Credit & collections | `PUT /collections/terms/:retailerId` (credit limit, credit days), `GET /collections/receivables` (aging buckets), `POST /collections/remind/:retailerId` (1 per 24 h) |
| Returns | `POST /returns` (Idempotency-Key, delivered orders only, within `RETURN_WINDOW_DAYS`, default 15), `GET /returns`, `POST /returns/:id/resolve` (approve = credit note + optional restock) |
| Photos | `POST /catalog/:id/images` (raw jpeg/png/webp body, max 1.5 MB, 5 per product), `DELETE /catalog/:id/images/:imageId`, `POST /catalog/:id/images/:imageId/cover`, `GET /media/:key` (public, immutable) |
| Sessions & 2FA | `GET /me/sessions`, `DELETE /me/sessions/:id`, `POST /me/sessions/revoke-others`, `POST /auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable` (admin) |
| Admin | `GET /admin/stats`, `/admin/audit`, `/admin/users`, `POST /admin/users/:id/status`; web console at `/admin-console/` |
| Partial fulfilment | `POST /orders/:id/transition` with `{ to: 'accepted', items: [{ product_id, qty }] }` ships less than ordered |
| Catalog depth | `GET /catalog/lookup?barcode=`, `GET /catalog/expiring?days=`, `POST/GET /catalog/:id/batches`, `POST /catalog/:id/batches/:batchId/write-off`; products take `barcode`, `variant_group`, `variant_label` |
| Online payments | `GET /payments/methods`, `POST /payments/gateway/link` (Idempotency-Key), `POST /payments/webhook` (signed, no login), `GET /collections/reconciliation`, `GET /admin/reconciliation`, `GET /ledger/statement.csv` |
| GST | `GET /compliance/orders/:id/einvoice`, `POST .../einvoice/generate`, `POST .../einvoice/irn`, `GET .../eway`, `POST .../eway/record` |
| Chat | `GET /chat/messages` also returns `peer_last_read_id`; socket event `message:read` |
| Network | `GET /retailer/stores` (pinned + `linked_distributors` + `nearby_distributors`), `GET /retailer/stores/:id` (profile), `GET /retailer/stores/:id/products` (only for stores the retailer may see) |
| Bills | `GET /ledger/invoices?retailer_id=` or `?distributor_id=` (amount, paid, due per bill) |
| Offers | `POST /announcements`, `GET /announcements/audience`, `GET /announcements`, `POST /announcements/seen`, `DELETE /announcements/:id` |
| Team | `GET /distributor/employees` (workload), `PUT /distributor/employees/:id`, `POST /distributor/employees/:id/reassign-all`, `PUT /distributor/me/availability`, `GET /distributor/deliveries`, `GET /orders?outside=1` |
| Subscription | `GET /subscription`, `POST /subscription/checkout`; admin: `GET/POST/PUT /admin/plans`, `GET /admin/subscription-payments`, `POST .../confirm`, `POST .../reject`, `GET/PUT /admin/settings` |
| Ops | `GET /health`, `GET /ready` (includes `ledger_immutable`), `GET /metrics` (Prometheus; needs `METRICS_TOKEN` in production) |
| Ledger | `POST /ledger/transaction` (Idempotency-Key), `POST /ledger/transaction/:id/reverse`, `GET /ledger/statement`, `POST /ledger/webhook/payment` |

## Deviations from the original blueprint (and why)
- Paise integers instead of floats/decimals; `amount` replaces `total_amount`/`paid_amount`.
- Ledger is append-only; running balance is locked on the retailer↔distributor relation row; `Idempotency-Key` required on writes.
- Cash denominations must sum to the amount and use valid notes.
- `distributor_id`/`retailer_id` are derived from the token, never trusted from the body.
- Online payments never post from a client call alone: they post after the distributor confirms a UPI payment, or via the gateway webhook (deduped by event id).
- Orders follow an explicit state machine; accepting posts the invoice and decrements stock in one transaction; cancelling after acceptance restores stock and reverses the invoice.
- Out-of-hierarchy commission rate is snapshotted on the order.
- Short-lived access JWT + rotating refresh tokens with reuse detection.

## Credit control, collections and returns
- Credit terms are per retailer↔distributor pair. An order is refused (`409 CREDIT_LIMIT_EXCEEDED`) when *dues + orders still waiting + the new order* exceed the limit; the check runs under the relation row lock so parallel orders cannot both pass.
- Aging is derived from the append-only ledger (payments and credit notes clear the oldest charge first); nothing is stored, so it cannot drift. A charge is overdue once a whole day has passed after `created_at + credit_days`.
- A daily job (10:00) reminds overdue retailers, at most once per 24 h per pair.
- Approving a return posts an idempotent `credit_note` and (optionally) restocks through `stock_movements` (`customer_return`).

## Self-updating database
`npm start` / `npm run dev` apply pending migrations before listening, and create the database itself on a fresh local server. Only one instance migrates at a time (advisory lock). Set `AUTO_MIGRATE=0` to manage it by hand with `npm run migrate`. To add a schema change, just drop a new numbered `.sql` file in `migrations/`.

## Push queue, payments and GST in one paragraph each
- **Push:** `notifyUsers()` writes to `push_outbox`; `flushOutbox()` sends with retry (1, 2, 4, 8, 16 min) and `checkReceipts()` confirms delivery. Admin stats show the last 24 h by status.
- **Gateway:** set `GATEWAY=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and point the gateway's webhook at `https://<api>/api/v1/payments/webhook` (event `payment_link.paid`). Without them the app offers UPI-with-UTR only.
- **GST:** fill the business address in the app; add HSN codes to products. `GET /compliance/orders/:id/einvoice` lists exactly what is missing. Set `EINVOICE_GSP_URL` (+ `EINVOICE_GSP_TOKEN`) to submit through a provider.

## Optional migrations
Files named `*.optional.sql` (e.g. the append-only triggers) are skipped with a warning if the database refuses them, and retried on the next `npm run migrate`. `/ready` reports `ledger_immutable: true` once the triggers exist.

## Online payments
UPI without gateway fees: the retailer pays the distributor's UPI id, submits the UTR, and the distributor confirms it (after seeing the money in their bank app). Only confirmation moves the ledger. A card/netbanking gateway (Razorpay etc.) can be added later through `POST /ledger/webhook/payment`.

## Production
`docker compose up -d --build` (needs `DB_PASSWORD` and a 32+ char `JWT_SECRET` in `.env`; the server refuses to start in production without them). Put it behind HTTPS (nginx/Caddy/cloud LB) and set `TRUST_PROXY=1`, `CORS_ORIGIN`. OTP email: set `SMTP_HOST/PORT/USER/PASS/FROM` (any SMTP provider; sent with Nodemailer). Never set `OTP_DEV_ECHO` in production. Back up the MySQL volume; the ledger is the system of record.

## Not built
Card/netbanking gateway, email, an admin web dashboard (admin screens exist in the mobile app), multi-language.
