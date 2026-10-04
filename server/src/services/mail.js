// Sending an email, which this app does for exactly one reason: to tell the
// admin that something they are not looking at went wrong (a backup that
// failed — services/backups.js). Nothing here is for users, and nothing a
// user types ever chooses an address: the recipient and the server are the
// admin's own configuration (app_config: smtp_url, smtp_from, alert_email).
//
// The transport is nodemailer over the SMTP URL the admin gave —
// smtp://user:pass@host:587 for STARTTLS, smtps://user:pass@host:465 for TLS
// from the first byte — built fresh per message, because messages are rare
// (a failure a day at the very worst) and a pooled connection would spend
// its life timing out. Tests inject `sendMailImpl` the way the LLM backends
// take a fake `run`.

import nodemailer from 'nodemailer';

// A loose shape check, not a validator: an address with no @ or a space in it
// is a typo, and anything else is for the SMTP server to judge.
export const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));

// What an smtp_url may be: one of the two schemes nodemailer reads, with a
// host. A URL that does not parse, or one for some other protocol, is refused
// at configuration time rather than at the moment an alert needs sending.
export function smtpUrlProblem(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'not a URL (expected smtp://user:pass@host:587 or smtps://…:465)';
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    return `unsupported scheme ${url.protocol.replace(/:$/, '')} (expected smtp or smtps)`;
  }
  if (!url.hostname) return 'no host in the URL';
  return null;
}

// Where mail from this app says it is from: the configured sender, else the
// SMTP login when that is an address (most providers refuse any other), else
// a name that at least says what sent it.
export function senderAddress({ smtp_url = '', smtp_from = '' } = {}) {
  const from = String(smtp_from || '').trim();
  if (from) return from;
  try {
    const user = decodeURIComponent(new URL(smtp_url).username || '');
    if (looksLikeEmail(user)) return user;
  } catch {
    // Not a URL — the problem is reported where it is configured.
  }
  return 'eurorack-assistant@localhost';
}

// Whether the configuration is complete enough to send anything at all.
export function mailConfigured(config) {
  return Boolean(String(config.smtp_url || '').trim()) && looksLikeEmail(config.alert_email);
}

// Sends one message to the alert address. Answers { sent: true, to } or
// { sent: false, reason } — a missing configuration is an answer, not an
// error, because the caller (a failed backup) has already got worse news to
// deliver and should go on recording it.
export async function sendAlertMail(config, { subject, text }, { sendMailImpl = null } = {}) {
  if (!mailConfigured(config)) {
    return {
      sent: false,
      reason: 'no SMTP server or alert address configured (Application Config → Alerts)',
    };
  }
  const message = {
    from: senderAddress(config),
    to: String(config.alert_email).trim(),
    subject,
    text,
  };
  const send =
    sendMailImpl || ((msg) => nodemailer.createTransport(String(config.smtp_url).trim()).sendMail(msg));
  await send(message);
  return { sent: true, to: message.to };
}
