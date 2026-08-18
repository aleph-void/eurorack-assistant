import crypto from 'node:crypto';
import { Op } from 'sequelize';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// The session cookie only gets the Secure attribute when the deployment
// actually serves HTTPS — setup.sh sets SECURE_COOKIES=1 alongside the TLS
// compose override. Defaulting it on would silently break the plain-HTTP
// setup (browsers drop Secure cookies over http://, so login would appear to
// succeed and every following request would be a 401).
export function secureCookies(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.SECURE_COOKIES ?? '').trim());
}

// Shared by res.cookie and res.clearCookie: a cookie is only cleared when the
// attributes match the ones it was set with, so both must come from here.
export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(env),
    path: '/',
  };
}

export const MIN_PASSWORD_LENGTH = 8;

// Single source of truth for the password policy, shared by every endpoint
// that accepts a password (self-service change, admin create, admin reset).
// Returns an error string, or null when the password is acceptable.
export function passwordProblem(password, { label = 'password' } = {}) {
  if (typeof password !== 'string' && typeof password !== 'number') {
    return `${label} is required`;
  }
  const value = String(password);
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

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
  // token_budget rides along because the budget guard runs on the request
  // path and would otherwise re-read the user on every call it protects; the
  // llm_* columns likewise, for the LLM settings route and requireLlmAccount.
  const { id, username, is_admin, must_change_password, token_budget, llm_provider, llm_model, llm_models } =
    session.User;
  return { id, username, is_admin, must_change_password, token_budget, llm_provider, llm_model, llm_models };
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
