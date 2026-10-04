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

// The address a password reset is sent to, so it is held to the same
// one-place rule as the password. Lowercased before it is stored or looked
// up: the local part of an address is case-sensitive on paper and on no mail
// provider anyone uses, and one account per address only holds if
// Nick@example.com and nick@example.com are the same key. An emptied field
// normalizes to NULL, which every route then refuses: the column is NOT NULL.
export const MAX_EMAIL_LENGTH = 254;

// The address an account from before migration 052 was given, under the
// reserved `.invalid` domain nothing is ever sent to. Unconfirmed by
// definition, which is what tells the page to ask for a real one.
export const PLACEHOLDER_EMAIL_DOMAIN = 'unset.invalid';
export const placeholderEmail = (username) =>
  `${String(username).toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`;
export const isPlaceholderEmail = (email) =>
  typeof email === 'string' && email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);

export function normalizeEmail(value) {
  if (value === null || value === undefined) return null;
  const email = String(value).trim().toLowerCase();
  return email === '' ? null : email;
}

// Returns an error string, or null when the (normalized) address will do.
// The shape check is deliberately loose — one @, something either side, a
// dot in the domain — because the only test of an address that matters is
// whether mail sent to it arrives, and that is what the confirmation step
// is for.
export function emailProblem(email) {
  if (typeof email !== 'string' || email === '') return 'email is required';
  if (email.length > MAX_EMAIL_LENGTH) {
    return `email must be at most ${MAX_EMAIL_LENGTH} characters`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'email must look like name@example.com';
  }
  // RFC 2606 reserves these for addresses that are not real, which is
  // exactly what the placeholder is and exactly what nobody may type in.
  if (/\.(invalid|test|example|localhost)$/.test(email)) {
    return 'email must be a real address';
  }
  return null;
}

// The user as every auth response describes them — the session lookup, the
// login and the self-service changes answer with the same shape so the client
// store can take any of them as the current user.
export function sessionUserJson(user) {
  const {
    id,
    username,
    email,
    email_verified_at,
    is_admin,
    must_change_password,
    token_budget,
    llm_provider,
    llm_model,
    llm_models,
    last_login_at,
  } = user;
  return {
    id,
    username,
    email,
    email_verified_at: email_verified_at ? new Date(email_verified_at).toISOString() : null,
    last_login_at: last_login_at ? new Date(last_login_at).toISOString() : null,
    is_admin,
    must_change_password,
    token_budget,
    llm_provider,
    llm_model,
    llm_models,
  };
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
  // A lock deletes the sessions, but one made between the lock's read and
  // its write would live on; a locked user is nobody here whatever the row
  // says.
  if (new Date(session.expires_at).getTime() < Date.now() || session.User.locked_at) {
    await deleteSession(db, token);
    return null;
  }
  // token_budget rides along because the budget guard runs on the request
  // path and would otherwise re-read the user on every call it protects; the
  // llm_* columns likewise, for the LLM settings route and requireLlmAccount.
  return sessionUserJson(session.User);
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
