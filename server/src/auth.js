import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function generatePassword(length = 20) {
  // URL/terminal-safe alphabet without ambiguous characters.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
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
  const { id, username, is_admin } = session.User;
  return { id, username, is_admin };
}

export function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const user = await getSessionUser(db, req.cookies?.[SESSION_COOKIE]);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
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
