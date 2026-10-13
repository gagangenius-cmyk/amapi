import request from 'supertest';
import type { Express } from 'express';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const uniq = () => `${Date.now().toString(36)}${++n}`;

/** A category the distributor can be set up with (onboarding needs at least one). */
export async function makeCategory(app: Express, adminToken: string, name = `Cat ${uniq()}`) {
  return (await request(app).post('/api/v1/admin/categories').set(auth(adminToken)).send({ name }).expect(201)).body as { id: number; name: string };
}

/** Start onboarding a distributor by UPI as a company employee. Returns the request and the login details. */
export async function startOnboarding(app: Express, admin: { token: string }, emp: { token: string }, over: Record<string, unknown> = {}) {
  await request(app).put('/api/v1/admin/settings').set(auth(admin.token)).send({ company_upi_id: 'aayme@okaxis', company_payee: 'AAYME' }).expect(200);
  // the plan comes from the admin's list, so this works even for an employee who lacks the power (and is expected to be refused)
  const meta = { plans: (await request(app).get('/api/v1/admin/plans').set(auth(admin.token)).expect(200)).body.plans as { id: number }[] };
  const category = over.category_ids ? null : await makeCategory(app, admin.token);
  const phone = String(over.phone ?? 6000000000 + Math.floor(Math.random() * 99999999));
  const body = {
    business_name: 'Biz ' + uniq(), name: 'Owner', phone, password: 'password123', plan_id: meta.plans[0].id, method: 'upi',
    category_ids: category ? [category.id] : undefined, ...over,
  };
  const res = await request(app).post('/api/v1/staff/onboarding').set(auth(emp.token)).set('Idempotency-Key', 'ob-' + uniq()).send(body);
  return { res, body, phone, plan: meta.plans[0], category };
}

/** The distributor pays by UPI, the employee reports the UTR, the admin confirms: the account now exists. */
export async function payAndConfirm(app: Express, admin: { token: string }, emp: { token: string }, requestId: number, utr = 'UTR' + uniq().toUpperCase().padEnd(8, 'X')) {
  await request(app).post(`/api/v1/staff/onboarding/${requestId}/utr`).set(auth(emp.token)).send({ utr }).expect(200);
  return request(app).post(`/api/v1/admin/onboarding/${requestId}/confirm`).set(auth(admin.token));
}

/** The whole thing, ending with a signed-in distributor. */
export async function onboardDistributor(app: Express, admin: { token: string }, emp: { token: string }, over: Record<string, unknown> = {}) {
  const s = await startOnboarding(app, admin, emp, over);
  if (s.res.status !== 201) throw new Error(`onboarding failed: ${s.res.status} ${JSON.stringify(s.res.body)}`);
  const done = await payAndConfirm(app, admin, emp, s.res.body.request.id);
  if (done.status !== 200) throw new Error(`confirm failed: ${done.status} ${JSON.stringify(done.body)}`);
  const login = (await request(app).post('/api/v1/auth/login').send({ phone: s.phone, password: 'password123' }).expect(200)).body;
  return { id: done.body.distributor_id as number, token: login.access_token as string, phone: s.phone, requestId: s.res.body.request.id as number, category: s.category, plan: s.plan };
}
