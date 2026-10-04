// Sending a mail.
//
// One function, `sendMail`, over the settings in mailConfig.js, with the
// transport (nodemailer, loaded on first use) as the seam tests replace —
// `createApp(db, { mailImpl })` threads a fake through to every route that
// sends. Nothing here throws for a mail that did not go: a user changing
// their address is a change that happened whether or not the confirmation
// reached them, so the caller gets `{ sent, problem }` and says so.

import { getMailConfig, mailConfigProblem } from './mailConfig.js';

export async function nodemailerSend(message, config) {
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.mail_host,
    port: config.mail_port,
    secure: config.mail_secure,
    auth: config.mail_user ? { user: config.mail_user, pass: config.mail_password } : undefined,
  });
  await transport.sendMail(message);
}

export async function sendMail(db, { to, subject, text }, { mailImpl = nodemailerSend } = {}) {
  const config = await getMailConfig(db);
  const problem = mailConfigProblem(config);
  if (problem) return { sent: false, problem: `Mail is not set up: ${problem}` };
  try {
    await mailImpl({ from: config.mail_from, to, subject, text }, config);
    return { sent: true, problem: null };
  } catch (e) {
    console.error(`mail to ${to} failed: ${e.message}`);
    return { sent: false, problem: `Mail could not be sent: ${e.message}` };
  }
}
