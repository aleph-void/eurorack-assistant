import { generatePassword, hashPassword } from './auth.js';

// Create the initial admin account with a random password. The cleartext
// password is only ever returned to the caller (the setup script prints it
// once); the database stores only the bcrypt hash.
//
// Returns { created, username, password? }. If an admin already exists,
// nothing is changed unless `reset` is true, which sets a new random password.
export async function ensureAdmin(db, { username = 'admin', reset = false } = {}) {
  const { rows } = await db.query('SELECT id, username FROM users WHERE is_admin = TRUE');
  if (rows.length > 0 && !reset) {
    return { created: false, username: rows[0].username };
  }

  const password = generatePassword(24);
  if (rows.length > 0) {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      rows[0].id,
      hashPassword(password),
    ]);
    return { created: false, reset: true, username: rows[0].username, password };
  }

  await db.query(
    'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE)',
    [username, hashPassword(password)]
  );
  return { created: true, username, password };
}
