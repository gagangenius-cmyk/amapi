import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const app = createApp();

describe('public legal pages (needed for app-store listing)', () => {
  afterEach(() => { delete process.env.COMPANY_NAME; delete process.env.SUPPORT_EMAIL; });

  it('serves the privacy policy without a login, and covers the data the app really uses', async () => {
    const r = await request(app).get('/privacy').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    for (const word of ['Privacy Policy', 'Location', 'Camera', 'Push notification', 'GSTIN', 'delete your account', 'anonymised']) expect(r.text.toLowerCase()).toContain(word.toLowerCase());
  });

  it('serves the account-deletion page with the in-app path and what is kept', async () => {
    const r = await request(app).get('/account-deletion').expect(200);
    expect(r.text).toContain('Account → Security');
    expect(r.text).toContain('anonymised');
    expect(r.text).toContain('open orders');
  });

  it('names the operator and contact from the server settings, escaped', async () => {
    process.env.COMPANY_NAME = 'Acme <b>Traders</b>';
    process.env.SUPPORT_EMAIL = 'help@acme.test';
    const r = await request(app).get('/privacy').expect(200);
    expect(r.text).toContain('Acme &lt;b&gt;Traders&lt;/b&gt;');
    expect(r.text).not.toContain('<b>Traders</b>');
    expect(r.text).toContain('mailto:help@acme.test');
  });

  it('is reachable on the same paths the Vercel rewrite sends to the app', async () => {
    await request(app).get('/api/v1/privacy').expect(404);   // not an API route
    await request(app).get('/privacy').expect(200);
  });
});
