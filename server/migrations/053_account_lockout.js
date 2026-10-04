// Locking an account.
//
// Five wrong passwords in a row lock the account they were tried against,
// and the admin can lock one by hand; either way nothing gets in until the
// admin unlocks it. The IP rate limiter (rateLimit.js) slows a guesser down;
// this stops them, because a guesser with many addresses is not slowed down
// at all. The count is a column rather than a log so it costs one UPDATE per
// failure and is read with the user on every login.

export const description = 'locking an account, by hand or after five failed logins';

export async function up({ addColumn, comment }) {
  await addColumn('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', 'locked_at', 'TIMESTAMPTZ');
  await addColumn('users', 'locked_reason', 'TEXT');
  await comment('COLUMN users.failed_logins', 'wrong passwords in a row; back to 0 on a login or an unlock');
  await comment('COLUMN users.locked_at', 'NULL while the account may log in');
  await comment('COLUMN users.locked_reason', "'failed_logins' or 'admin'; NULL while unlocked");
}

export async function down({ dropColumn }) {
  await dropColumn('users', 'failed_logins', 'locked_at', 'locked_reason');
}
