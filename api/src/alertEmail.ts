import nodemailer from 'nodemailer';
import { getAlertConfig } from './alertConfig';

/**
 * Sends an alert email via a generic SMTP relay, configured from
 * alert_email_config (editable at /admin) rather than .env — this is the
 * one piece of site config meant to be changed at runtime without shell
 * access to the Pi. Returns cleanly-described errors rather than throwing
 * raw nodemailer errors, since callers (the systemd-timer script, and the
 * /admin "send test email" button) just surface this message directly.
 */
export async function sendAlertEmail(subject: string, text: string): Promise<void> {
  const { email } = getAlertConfig();
  if (!email) {
    throw new Error('Email alerting is not configured — set it up under Admin.');
  }

  const transport = nodemailer.createTransport({
    host: email.smtpHost,
    port: email.smtpPort,
    secure: email.smtpPort === 465,
    auth: { user: email.smtpUser, pass: email.smtpPass },
  });

  await transport.sendMail({ from: email.smtpUser, to: email.alertTo, subject, text });
}
