// Confirming that an address is the user's.
//
// An address is a claim until mail sent to it comes back: a link carrying a
// random token is mailed, and following it proves whoever reads that inbox
// is whoever is logged in. The token is stored HASHED (sha-256) with the
// address it was sent to and an expiry — one outstanding confirmation per
// user, a new one replacing the last — and `users.email_verified_at` is set
// when it is redeemed. Any change of address, the user's own or the admin's,
// clears that and starts over, because the proof was of the old one.
//
// The link is opened wherever the mail is read, which need not be a browser
// that is logged in, so redeeming a token takes no session.

import crypto from 'node:crypto';
import { getMailConfig, publicLink } from './mailConfig.js';

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
// A second mail inside this window is the first one again, not sent.
export const RESEND_INTERVAL_MS = 60 * 1000;
const TOKEN_BYTES = 32;

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function verificationMail({ username, link }) {
  return {
    subject: 'Confirm your email address',
    text: [
      `Hello ${username},`,
      '',
      'This address was given for your Eurorack Assistant account. Open the link',
      'below to confirm it is yours:',
      '',
      link,
      '',
      'The link works for 24 hours. If you did not expect this mail, ignore it;',
      'the address is not confirmed until the link is opened.',
    ].join('\n'),
  };
}

// Replaces any outstanding confirmation and mails the new one. Returns what
// sendMail returns — the row is written either way, so a mail that did not
// go can be sent again from the page.
export async function startEmailVerification(db, user, { sendMail, now = Date.now() }) {
  const { EmailVerification } = db.models;
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  await db.sequelize.transaction(async (transaction) => {
    await EmailVerification.destroy({ where: { user_id: user.id }, transaction });
    await EmailVerification.create(
      {
        user_id: user.id,
        email: user.email,
        token_hash: hashToken(token),
        expires_at: new Date(now + VERIFICATION_TTL_MS),
      },
      { transaction }
    );
  });
  const config = await getMailConfig(db);
  const link = publicLink(config, `/verify-email?token=${token}`);
  return sendMail({ to: user.email, ...verificationMail({ username: user.username, link }) });
}

// The user asking for the mail again. `tooSoon` when the last one is under a
// minute old, which the route answers 429.
export async function resendEmailVerification(db, user, { sendMail, now = Date.now() }) {
  const latest = await db.models.EmailVerification.findOne({
    where: { user_id: user.id },
    order: [['id', 'DESC']],
  });
  if (latest && now - new Date(latest.created_at).getTime() < RESEND_INTERVAL_MS) {
    return { sent: false, tooSoon: true, problem: 'A confirmation was sent less than a minute ago' };
  }
  return startEmailVerification(db, user, { sendMail, now });
}

// Redeeming the token from the link. One answer for every way it can fail —
// unknown, expired, the address changed since — because the difference is
// nobody's business but the database's.
export async function confirmEmailVerification(db, token, { now = Date.now() } = {}) {
  const { EmailVerification, User } = db.models;
  const failure = { ok: false, problem: 'This confirmation link is not valid or has expired' };
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return failure;
  const row = await EmailVerification.findOne({ where: { token_hash: hashToken(token) } });
  if (!row) return failure;
  const user = await User.findByPk(row.user_id);
  const stale = new Date(row.expires_at).getTime() <= now || !user || user.email !== row.email;
  if (stale) {
    await row.destroy();
    return failure;
  }
  await db.sequelize.transaction(async (transaction) => {
    await user.update({ email_verified_at: new Date(now) }, { transaction });
    await EmailVerification.destroy({ where: { user_id: user.id }, transaction });
  });
  return { ok: true, user };
}
