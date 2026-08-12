import { generatePassword, hashPassword } from './auth.js';

// Create the initial admin account with a random password. The cleartext
// password is only ever returned to the caller (the setup script prints it
// once); the database stores only the bcrypt hash.
//
// Returns { created, username, password? }. If an admin already exists,
// nothing is changed unless `reset` is true, which sets a new random password.
export async function ensureAdmin(db, { username = 'admin', reset = false } = {}) {
  const { User } = db.models;
  const admin = await User.findOne({ where: { is_admin: true } });
  if (admin && !reset) {
    return { created: false, username: admin.username };
  }

  const password = generatePassword(24);
  if (admin) {
    await admin.update({ password_hash: hashPassword(password) });
    return { created: false, reset: true, username: admin.username, password };
  }

  await User.create({ username, password_hash: hashPassword(password), is_admin: true });
  return { created: true, username, password };
}
