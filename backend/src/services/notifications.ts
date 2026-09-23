import nodemailer from "nodemailer";
import { env } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";

const mailer = env.SMTP_HOST ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined }) : null;
export async function sendEmail(userId: string | undefined, to: string, subject: string, body: string) {
  const n = await prisma.notification.create({ data: { userId: userId || undefined, channel: "EMAIL", recipient: to, subject, body } });
  if (!mailer || !env.MAIL_FROM) return n;
  try { await mailer.sendMail({ from: env.MAIL_FROM, to, subject, text: body }); await prisma.notification.update({ where: { id: n.id }, data: { sentAt: new Date() } }); }
  catch (e) { await prisma.notification.update({ where: { id: n.id }, data: { error: e instanceof Error ? e.message : "Email failed" } }); }
  return n;
}
export async function sendSms(userId: string | undefined, to: string, body: string) {
  const n = await prisma.notification.create({ data: { userId: userId || undefined, channel: "SMS", recipient: to, body } });
  if (!env.SMS_WEBHOOK_URL) return n;
  try { const r = await fetch(env.SMS_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", ...(env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.SMS_WEBHOOK_TOKEN}` } : {}) }, body: JSON.stringify({ to, message: body }) }); if (!r.ok) throw new Error(`SMS provider returned ${r.status}`); await prisma.notification.update({ where: { id: n.id }, data: { sentAt: new Date() } }); }
  catch (e) { await prisma.notification.update({ where: { id: n.id }, data: { error: e instanceof Error ? e.message : "SMS failed" } }); }
  return n;
}
