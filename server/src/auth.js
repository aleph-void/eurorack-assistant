import crypto from 'node:crypto';
import { Op } from 'sequelize';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// Passwords are stored as PBKDF2-HMAC-SHA512 hashes in a self-describing
// format: pbkdf2$<digest>$<iterations>$<salt hex>$<derived key hex>.
// Verification reads the parameters from the stored hash, so these constants
// can be raised later without invalidating existing hashes.
export const PBKDF2_DIGEST = 'sha512';
export const PBKDF2_ITERATIONS = 210000; // OWASP recommendation for SHA-512
export const PBKDF2_KEY_BYTES = 32;
export const PBKDF2_SALT_BYTES = 16;

export function hashPassword(password) {
  const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
  const key = crypto.pbkdf2Sync(
    String(password),
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_BYTES,
    PBKDF2_DIGEST
  );
  return [
    'pbkdf2',
    PBKDF2_DIGEST,
    PBKDF2_ITERATIONS,
    salt.toString('hex'),
    key.toString('hex'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterationsRaw, saltHex, keyHex] = parts;
  const iterations = Number(iterationsRaw);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  if (!Number.isInteger(iterations) || iterations < 1 || expected.length === 0) return false;
  try {
    const actual = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length, digest);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    // Unknown digest or malformed hash — never authenticates.
    return false;
  }
}

export function generatePassword(length = 20) {
  // URL/terminal-safe alphabet without ambiguous characters.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function generateHexPassword(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.models.Session.create({ token, user_id: userId, expires_at: expiresAt });
  return { token, expiresAt };
}

export async function deleteSession(db, token) {
  await db.models.Session.destroy({ where: { token } });
}

// Invalidates every session of a user, optionally sparing one token (so a
// user changing their own password stays logged in on the current browser).
export async function deleteUserSessions(db, userId, { exceptToken = null, transaction = null } = {}) {
  const where = { user_id: userId };
  if (exceptToken) where.token = { [Op.ne]: exceptToken };
  await db.models.Session.destroy({ where, transaction });
}

export async function getSessionUser(db, token) {
  if (!token) return null;
  const session = await db.models.Session.findOne({
    where: { token },
    include: db.models.User,
  });
  if (!session || !session.User) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await deleteSession(db, token);
    return null;
  }
  const { id, username, is_admin, must_change_password } = session.User;
  return { id, username, is_admin, must_change_password };
}

// A user flagged must_change_password is locked out of everything except the
// auth endpoints (which opt in with allowPasswordChange) until they set a new
// password.
export function requireAuth(db, { allowPasswordChange = false } = {}) {
  return async (req, res, next) => {
    try {
      const user = await getSessionUser(db, req.cookies?.[SESSION_COOKIE]);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      if (user.must_change_password && !allowPasswordChange) {
        return res
          .status(403)
          .json({ error: 'Password change required', code: 'password_change_required' });
      }
      req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireAdmin() {
  return (req, res, next) => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
  };
}
