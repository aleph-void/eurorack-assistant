// When each account last logged in.
//
// Set on every successful password login and nowhere else — a session
// cookie being presented is the same login continuing, and a device token
// refreshing itself is a machine, not a person. It is what tells the admin
// which accounts are in use, and what tells the user that somebody logged
// in as them when they did not.

export const description = 'when each account last logged in';

export async function up({ addColumn, comment }) {
  await addColumn('users', 'last_login_at', 'TIMESTAMPTZ');
  await comment('COLUMN users.last_login_at', 'the last successful password login; NULL for an account never logged in to');
}

export async function down({ dropColumn }) {
  await dropColumn('users', 'last_login_at');
}
