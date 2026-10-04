import {
  deleteUserSessions,
  generateHexPassword,
  hashPassword,
  normalizeEmail,
  placeholderEmail,
} from './auth.js';

// Create the initial admin account with a random hex password. The cleartext
// password is only ever returned to the caller (the setup script prints it
// once); the database stores only the PBKDF2 hash. The admin is flagged
// must_change_password so the generated password works exactly once: the
// first login forces them to pick their own.
//
// Returns { created, username, password? }. If an admin already exists,
// nothing is changed unless `reset` is true, which sets a new random password
// (again forcing a change at the next login) and invalidates the admin's
// existing sessions.
//
// `email` is the admin's address when the installer knows it (ADMIN_EMAIL);
// otherwise the placeholder every pre-052 account carries, which the admin
// is asked to replace at their first visit to the account page.
export async function ensureAdmin(db, { username = 'admin', email = null, reset = false } = {}) {
  const { User } = db.models;
  const admin = await User.findOne({ where: { is_admin: true } });
  if (admin && !reset) {
    return { created: false, username: admin.username };
  }

  const password = generateHexPassword(16);
  if (admin) {
    // The reset and the session invalidation land atomically.
    await db.sequelize.transaction(async (transaction) => {
      await admin.update(
        { password_hash: hashPassword(password), must_change_password: true },
        { transaction }
      );
      await deleteUserSessions(db, admin.id, { transaction });
    });
    return { created: false, reset: true, username: admin.username, password };
  }

  await User.create({
    username,
    email: normalizeEmail(email) || placeholderEmail(username),
    password_hash: hashPassword(password),
    is_admin: true,
    must_change_password: true,
  });
  return { created: true, username, password };
}
