import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Email delivery through Nodemailer (SMTP). Configure with:
 *   SMTP_HOST, SMTP_PORT (587 or 465), SMTP_USER, SMTP_PASS, SMTP_FROM ("AAYME <no-reply@yourdomain>"), SMTP_SECURE=1 for port 465.
 * Without SMTP_HOST, emails are only logged (development). Under test they are captured in `testOutbox`.
 */
export interface Mail { to: string; subject: string; text: string; html?: string }

export const testOutbox: Mail[] = [];
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) return (transporter = null);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

export async function sendMail(mail: Mail) {
  // Under test, mail is captured unless a test points SMTP_HOST at a local fake SMTP server.
  if (env.isTest && !process.env.SMTP_HOST) { testOutbox.push(mail); return; }
  // Preferred: Resend's HTTPS API (works on serverless hosts where SMTP ports are blocked). RESEND_API_KEY + MAIL_FROM ("AAYME <no-reply@yourdomain>").
  if (process.env.RESEND_API_KEY && !env.isTest) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM ?? process.env.SMTP_FROM ?? 'AAYME <onboarding@resend.dev>', to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const t = getTransporter();
  if (!t && env.isProd) throw new Error('No email provider configured (set RESEND_API_KEY or SMTP_HOST)');
  if (!t) {
    logger.warn({ to: mail.to, subject: mail.subject }, 'SMTP not configured; email not sent (dev only)');
    if (process.env.NODE_ENV === 'development') console.log(`[mail:dev] to ${mail.to}\n${mail.subject}\n${mail.text}\n`);
    return;
  }
  await t.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, ...mail });
}

export function otpEmail(to: string, code: string, minutes: number, purpose: 'login' | 'reset' | 'verify'): Mail {
  const what = purpose === 'reset' ? 'reset your password' : purpose === 'verify' ? 'confirm your email address' : 'sign in';
  return {
    to,
    subject: `Your AAYME verification code: ${code}`,
    text: `Use this code to ${what}: ${code}\n\nIt is valid for ${minutes} minutes and can be used once.\nIf you did not ask for it, you can ignore this email; nobody can sign in without the code.`,
    html: `<div style="font-family:Arial,sans-serif;color:#0B1F3A"><h2 style="margin:0 0 8px">AAYME</h2>
      <p>Use this code to ${what}:</p>
      <p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>
      <p style="color:#6B7788;font-size:13px">Valid for ${minutes} minutes and works once. If you did not ask for it, ignore this email.</p></div>`,
  };
}
