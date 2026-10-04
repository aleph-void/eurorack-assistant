// An email address on the user record.
//
// Until now an account was a username and a password and nothing else, which
// is fine for logging in and useless for getting back in: a forgotten
// password could only be reset by the admin, by hand. The address is where a
// password reset will be sent, and later where a registration is confirmed
// before the admin approves it — so it is a fact about the account, kept
// beside the credentials rather than in a profile table of its own.
//
// Nullable, because every account made so far has none. Stored lowercased by
// the code that writes it (auth.js `normalizeEmail`), so a plain unique index
// is enough to make it one account per address — pg-mem, which the tests
// run on, cannot build a functional index on lower(email).

export const description = 'an email address on the user record';

export async function up({ addColumn, createIndex, comment }) {
  await addColumn('users', 'email', 'TEXT');
  await createIndex('users_email_unique', 'users', ['email'], { unique: true });
  await comment(
    'COLUMN users.email',
    'where a password reset is sent; lowercased on write, NULL for an account with none'
  );
}

export async function down({ dropColumn, dropIndex }) {
  await dropIndex('users_email_unique');
  await dropColumn('users', 'email');
}
