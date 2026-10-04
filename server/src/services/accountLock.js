// Locking an account (migration 053).
//
// Two ways in, one way out. Five wrong passwords in a row lock the account
// they were tried against, and the admin locks one by hand; either way only
// the admin unlocks it. The IP rate limiter (rateLimit.js) slows a guesser
// down, this stops them — a guesser with many addresses is not slowed down
// at all — and a lock by hand is how an account is shut without deleting
// what it owns.
//
// Locking is also a logout: every session goes and every device token is
// revoked, so the lock takes effect now rather than when the cookie expires,
// and getSessionUser() refuses a locked user besides, for the session that
// slipped between the two.

import { deleteUserSessions } from '../auth.js';
import { revokeUserDeviceTokens } from './deviceAuth.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_REASONS = ['failed_logins', 'admin'];

export const LOCKED_MESSAGE = 'This account is locked. Ask an administrator to unlock it.';

export function isLocked(user) {
  return Boolean(user?.locked_at);
}

export async function lockUser(db, user, { reason, now = Date.now(), transaction = null } = {}) {
  if (!LOCK_REASONS.includes(reason)) throw new Error(`Invalid lock reason: ${reason}`);
  const run = async (t) => {
    await user.update({ locked_at: new Date(now), locked_reason: reason }, { transaction: t });
    await deleteUserSessions(db, user.id, { transaction: t });
    await revokeUserDeviceTokens(db, user.id, { transaction: t });
  };
  if (transaction) return run(transaction);
  return db.sequelize.transaction(run);
}

// Unlocking forgets the failures too: the count is of wrong passwords IN A
// ROW, and the admin letting the user back in ends the row.
export async function unlockUser(db, user) {
  await user.update({ locked_at: null, locked_reason: null, failed_logins: 0 });
}

// One more wrong password. Returns whether this one shut the account.
export async function recordFailedLogin(db, user, { now = Date.now() } = {}) {
  const failed = Number(user.failed_logins || 0) + 1;
  await user.update({ failed_logins: failed });
  if (failed < MAX_FAILED_LOGINS || isLocked(user)) return { locked: isLocked(user), failed };
  await lockUser(db, user, { reason: 'failed_logins', now });
  return { locked: true, failed };
}

// A right password ends the row of wrong ones.
export async function recordLogin(db, user) {
  if (Number(user.failed_logins || 0) !== 0) await user.update({ failed_logins: 0 });
}
