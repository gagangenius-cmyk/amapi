import { Router } from 'express';

/**
 * Public legal pages that app stores require: a privacy policy and an account-deletion page.
 * They describe what THIS app really does (see account.routes.ts for deletion). Set COMPANY_NAME and SUPPORT_EMAIL on the server
 * so the pages name the real operator; have your own legal adviser review the wording before you publish the app.
 */
export const legalRouter = Router();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const company = () => esc(process.env.COMPANY_NAME?.trim() || 'AAYME');
const contact = () => {
  const e = process.env.SUPPORT_EMAIL?.trim();
  return e ? `<a href="mailto:${esc(e)}">${esc(e)}</a>` : 'the Support section inside the app (Account → Support)';
};
const UPDATED = '2026-10-29';

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${company()}</title>
<style>
  body{margin:0;background:#070720;color:#F4F5FF;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:30px;margin:0 0 4px}h2{font-size:19px;margin:30px 0 6px;color:#1EC8FF}
  p,li{color:#D6D8F5}a{color:#1EC8FF}small{color:#9A9DCB}
  table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #262963;padding:8px 10px;text-align:left;vertical-align:top;font-size:15px}th{background:#0F1030}
</style></head><body><main>${body}</main></body></html>`;

legalRouter.get('/privacy', (_req, res) => {
  res.type('html').send(page('Privacy Policy', `
<h1>Privacy Policy</h1><small>${company()} · last updated ${UPDATED}</small>
<p>${company()} ("we") runs the AAYME app, which connects distributors, their staff and retailers for ordering, delivery, payments tracking (khata) and support. This page explains what information the app handles and why.</p>

<h2>Information we collect</h2>
<table>
<tr><th>What</th><th>Why we need it</th></tr>
<tr><td>Name, phone number, email, password (stored only as a one-way hash)</td><td>To create your account and sign you in; to send sign-in and verification codes.</td></tr>
<tr><td>Business details you enter: shop or business name, address, city, pincode, GSTIN, UPI id and bank details (distributors)</td><td>To show your store to retailers, print GST invoices, and let retailers pay you.</td></tr>
<tr><td>Orders, invoices, payments, returns, khata (credit) entries, prices and stock</td><td>To run the ordering and accounting features. These are business records.</td></tr>
<tr><td>Chat messages and support tickets, including photos or PDFs you attach</td><td>To communicate with the other party and with support.</td></tr>
<tr><td>Location (only when you choose to save your shop location or to record a visit)</td><td>To mark a shop on the map and to check that a field visit happened at the shop. We do not track you in the background.</td></tr>
<tr><td>Camera and photos (only when you scan a barcode or QR code, take a product photo, or attach a file)</td><td>To scan products and visit codes and to add pictures. Images are stored only when you upload them.</td></tr>
<tr><td>Push notification token and device type</td><td>To send order, payment and offer notifications.</td></tr>
<tr><td>Security records: sign-in time, IP address, device description, failed attempts</td><td>To protect accounts, show you your recent sign-ins, and detect misuse.</td></tr>
</table>
<p>We do not collect card or net-banking details. UPI payments are made in your own UPI app; you only enter the reference number so the receiver can confirm it.</p>

<h2>Who can see your information</h2>
<ul>
<li><b>Other users you deal with.</b> A retailer and the distributor they trade with see each other's business name, contact details, orders, invoices and khata balance. A distributor's staff see what the distributor lets them handle.</li>
<li><b>Our team and service providers.</b> Hosting, database, file storage, email delivery and push-notification services process data for us under our instructions. Push notifications are delivered through Expo's notification service.</li>
<li><b>Authorities</b> where the law requires it. We do not sell your personal information or use it for advertising.</li>
</ul>

<h2>Security</h2>
<p>Data is sent over HTTPS. Passwords are hashed; sign-in sessions can be reviewed and ended in Account → Security. You can also lock the app with your phone's fingerprint, face or PIN.</p>

<h2>Keeping and deleting your information</h2>
<p>You can export your data and delete your account inside the app (Account → Security &amp; privacy). Deleting an account removes your name, phone, email, credentials and push tokens, and replaces your chat messages. <b>Orders, invoices and khata entries are kept in anonymised form</b> because both parties need these financial records and tax rules require us to keep them. An account cannot be deleted while money is owed or orders are still open. More detail: <a href="/account-deletion">account deletion</a>.</p>

<h2>Your choices</h2>
<ul><li>Location, camera, photo and notification permissions can be switched off in your phone's settings; the related feature will then be unavailable.</li>
<li>You can ask us to correct your information from the app, or by contacting ${contact()}.</li></ul>

<h2>Children</h2><p>The app is for businesses and is not directed at children under 18.</p>

<h2>Changes</h2><p>If we change this policy we will update the date above and, for significant changes, tell you in the app.</p>

<h2>Contact</h2><p>Questions about privacy: ${contact()}.</p>`));
});

legalRouter.get('/account-deletion', (_req, res) => {
  res.type('html').send(page('Delete your account', `
<h1>Delete your AAYME account</h1><small>${company()} · last updated ${UPDATED}</small>
<h2>How to delete your account</h2>
<ol>
<li>Open the AAYME app and sign in.</li>
<li>Go to <b>Account → Security &amp; privacy</b>.</li>
<li>Scroll to <b>Delete account</b>, enter your password and confirm.</li>
</ol>
<p>If you cannot sign in, contact ${contact()} from the phone number or email registered on the account and we will help.</p>

<h2>What is deleted</h2>
<ul><li>Your name, phone number, email address and password.</li>
<li>Your push-notification registrations and active sign-in sessions.</li>
<li>Your chat messages (replaced with "[deleted]").</li>
<li>For distributors: bank/UPI details and GSTIN are removed, products are removed from the catalog, subscription ends, and staff logins are switched off. For retailers: the shop name and address are removed.</li></ul>

<h2>What is kept</h2>
<p>Orders, invoices, payments and khata entries are retained in anonymised form (they point to a "Deleted user"), because the other business needs them and tax and accounting rules require us to keep financial records.</p>

<h2>When deletion is not possible yet</h2>
<p>An account with an unsettled khata balance or open orders cannot be deleted. Settle or cancel those first, then delete. Administrator accounts are managed by the company and cannot be self-deleted.</p>`));
});
