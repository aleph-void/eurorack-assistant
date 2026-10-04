// An email address on every user record, and whether it has been confirmed.
//
// Until now an account was a username and a password and nothing else, which
// is fine for logging in and useless for getting back in: a forgotten
// password could only be reset by the admin, by hand. The address is where a
// password reset is sent, and where a registration is confirmed before the
// admin approves it — so it is a fact about the account, kept beside the
// credentials rather than in a profile table of its own, and REQUIRED.
//
// The accounts made before this migration have no address to give it. They
// get a placeholder under the reserved `.invalid` top-level domain
// (`<username>@unset.invalid` — RFC 2606 guarantees it never resolves, so
// nothing is ever sent there), left unconfirmed, which is what tells the
// page to ask for a real one. `emailProblem()` refuses that domain, so no
// one can type one in.
//
// Stored lowercased by the code that writes it (auth.js `normalizeEmail`),
// so a plain unique index is enough to make it one account per address —
// pg-mem, which the tests run on, cannot build a functional index on
// lower(email).
//
// `email_verifications` holds the one outstanding confirmation per user: the
// hash of the token in the link that was mailed (never the token itself —
// the table is no use to anyone who reads it), the address it was sent to
// (a token proves THAT address, and an address changed since is a different
// one) and when it stops being honoured.

export const description = 'an email address on the user record, and its confirmation';

export async function up({ sql, addColumn, createIndex, comment }) {
  await addColumn('users', 'email', 'TEXT');
  await sql`UPDATE users SET email = username || '@unset.invalid'`;
  await sql`ALTER TABLE users ALTER COLUMN email SET NOT NULL`;
  await createIndex('users_email_unique', 'users', ['email'], { unique: true });
  await addColumn('users', 'email_verified_at', 'TIMESTAMPTZ');
  await comment(
    'COLUMN users.email',
    'where a password reset is sent; lowercased on write; <username>@unset.invalid for an account from before the column'
  );
  await comment(
    'COLUMN users.email_verified_at',
    'when the user followed the link mailed to this address; NULL until they do, and again whenever the address changes'
  );

  await sql`
CREATE TABLE email_verifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);
`;
}

export async function down({ dropTable, dropColumn, dropIndex }) {
  await dropTable('email_verifications');
  await dropIndex('users_email_unique');
  await dropColumn('users', 'email_verified_at', 'email');
}
