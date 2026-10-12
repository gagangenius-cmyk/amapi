import { AddressInfo } from 'net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A real SMTP conversation over TCP: proves Nodemailer delivers, not just that we call it.
let server: SMTPServer;
const received: { from: string; to: string[]; raw: string; user?: string }[] = [];
import type * as Mailer from '../src/services/mailer';
let sendMail: typeof Mailer.sendMail;
let otpEmail: typeof Mailer.otpEmail;

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, cb) {
      if (auth.username === 'mailer' && auth.password === 'secret') cb(null, { user: auth.username });
      else cb(new Error('Invalid login'));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => { raw += c.toString(); });
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw, user: (session as any).user });
        cb();
      });
    },
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String((server.server.address() as AddressInfo).port);
  process.env.SMTP_USER = 'mailer';
  process.env.SMTP_PASS = 'secret';
  process.env.SMTP_FROM = 'AAYME <no-reply@aayme.test>';
  ({ sendMail, otpEmail } = await import('../src/services/mailer.js'));
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('Nodemailer SMTP delivery', () => {
  it('delivers the OTP email over real SMTP with auth, correct headers and the code in the body', async () => {
    await sendMail(otpEmail('retailer@example.com', '482913', 5, 'login'));
    expect(received).toHaveLength(1);
    const m = received[0];
    expect(m.to).toEqual(['retailer@example.com']);
    expect(m.from).toBe('no-reply@aayme.test');
    expect(m.user).toBe('mailer');
    expect(m.raw).toContain('Subject: Your AAYME verification code: 482913');
    expect(m.raw).toContain('From: AAYME <no-reply@aayme.test>');
    expect(m.raw).toContain('482913');
    expect(m.raw).toMatch(/Content-Type: multipart\/alternative/); // plain-text + HTML versions
  });

  it('reset emails say so', async () => {
    await sendMail(otpEmail('a@example.com', '111222', 5, 'reset'));
    expect(received[1].raw).toContain('reset your password');
  });

  it('surfaces SMTP failures to the caller (the OTP route logs them and still answers 202)', async () => {
    const prev = process.env.SMTP_PASS;
    // a fresh module instance with a wrong password
    process.env.SMTP_PASS = 'wrong';
    const { vi } = await import('vitest');
    vi.resetModules();
    const fresh = await import('../src/services/mailer.js');
    await expect(fresh.sendMail(fresh.otpEmail('x@example.com', '999999', 5, 'login'))).rejects.toThrow();
    process.env.SMTP_PASS = prev;
    expect(received).toHaveLength(2); // nothing extra was delivered
  });
});
