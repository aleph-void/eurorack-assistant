// OAuth 2.0 device authorization grant (RFC 8628) for hardware-adjacent
// applications — an oscilloscope on the bench next to the rack, which has a
// URL to this server and no business holding the user's password.
//
// The flow: the app asks for a device code, shows the short user code, and
// polls the token endpoint while the user approves that code in a browser
// session they are already logged into. Nothing but the user's own approval
// mints a token, and every token can be revoked from the web UI.
//
// Token values live in the database as sha256 hashes. They are 32 random
// bytes, so there is nothing to brute-force but the full key space and a fast
// hash is the right tool (unlike passwords, which use PBKDF2 in auth.js).

import crypto from 'node:crypto';
import { Op } from 'sequelize';

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // RFC 8628 recommends ~10 min
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// No vowels (so a code can never spell something), no 0/O/1/I/L — the user
// reads this off one screen and types it into another.
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
const USER_CODE_LENGTH = 8;

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateUserCode() {
  const bytes = crypto.randomBytes(USER_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// User codes are compared with the dashes and case the user did not type.
export function normalizeUserCode(raw) {
  const cleaned = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== USER_CODE_LENGTH) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

// The scopes a request may actually get: the intersection of what it asked
// for and what the client is registered for. An empty request means "all of
// the client's scopes".
export function resolveScopes(requested, allowed) {
  const allowedSet = new Set(String(allowed || '').split(/\s+/).filter(Boolean));
  const asked = String(requested || '').split(/\s+/).filter(Boolean);
  if (asked.length === 0) return [...allowedSet].join(' ');
  const granted = asked.filter((s) => allowedSet.has(s));
  return granted.length === asked.length ? granted.join(' ') : null;
}

export function hasScope(scopes, scope) {
  return String(scopes || '')
    .split(/\s+/)
    .includes(scope);
}

export async function findClient(db, clientId) {
  if (!clientId) return null;
  const client = await db.models.OAuthClient.findOne({
    where: { client_id: String(clientId) },
  });
  return client && client.enabled ? client : null;
}

// Step 1: the app asks for a code pair. Returns the plaintext device code
// (never stored) alongside the row.
export async function createDeviceAuthorization(
  db,
  { clientId, scopes, deviceName = null, now = Date.now() }
) {
  const deviceCode = generateToken();
  // A collision on the short user code is astronomically unlikely but not
  // impossible; retry rather than 500 on the unique index.
  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const userCode = generateUserCode();
    const existing = await db.models.DeviceAuthorization.findOne({
      where: { user_code: userCode },
    });
    if (existing && new Date(existing.expires_at).getTime() > now) continue;
    if (existing) await existing.destroy();
    row = await db.models.DeviceAuthorization.create({
      client_id: clientId,
      device_code_hash: hashToken(deviceCode),
      user_code: userCode,
      scopes,
      device_name: deviceName,
      status: 'pending',
      interval_seconds: DEVICE_POLL_INTERVAL_SECONDS,
      expires_at: new Date(now + DEVICE_CODE_TTL_MS),
    });
  }
  if (!row) throw new Error('could not allocate a user code');
  return { authorization: row, deviceCode };
}

// The pending authorization behind a user code, for the approval screen.
export async function findPendingAuthorization(db, userCode, { now = Date.now() } = {}) {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const row = await db.models.DeviceAuthorization.findOne({ where: { user_code: code } });
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now) return null;
  if (row.status !== 'pending') return null;
  return row;
}

// Step 2: the user says yes (or no) in the web UI. `name` is what the token
// will be called in the device list.
export async function decideDeviceAuthorization(
  db,
  { userCode, userId, approve, name = null, now = Date.now() }
) {
  const row = await findPendingAuthorization(db, userCode, { now });
  if (!row) return null;
  await row.update({
    status: approve ? 'approved' : 'denied',
    user_id: approve ? userId : null,
    device_name: name || row.device_name,
  });
  return row;
}

export async function issueDeviceToken(
  db,
  { userId, clientId, name, scopes, now = Date.now(), transaction = null }
) {
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const row = await db.models.DeviceToken.create(
    {
      user_id: userId,
      client_id: clientId,
      name: name || 'Oscilloscope',
      access_token_hash: hashToken(accessToken),
      refresh_token_hash: hashToken(refreshToken),
      scopes,
      expires_at: new Date(now + ACCESS_TOKEN_TTL_MS),
    },
    { transaction }
  );
  return { token: row, accessToken, refreshToken };
}

const tokenResponse = (accessToken, refreshToken, row) => ({
  access_token: accessToken,
  token_type: 'Bearer',
  expires_in: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
  refresh_token: refreshToken,
  scope: row.scopes,
});

// Step 3: the app polls with its device code. Returns either an RFC 6749 /
// 8628 error code or a token response.
export async function claimDeviceToken(db, { deviceCode, clientId, now = Date.now() }) {
  const row = await db.models.DeviceAuthorization.findOne({
    where: { device_code_hash: hashToken(deviceCode || '') },
  });
  if (!row || row.client_id !== clientId) return { error: 'invalid_grant' };
  if (new Date(row.expires_at).getTime() <= now) return { error: 'expired_token' };

  // Polling faster than the advertised interval earns a slow_down, per
  // RFC 8628 §3.5 — and the client is required to back off after one.
  const last = row.last_polled_at ? new Date(row.last_polled_at).getTime() : 0;
  const tooFast = last > 0 && now - last < row.interval_seconds * 1000;
  await row.update({ last_polled_at: new Date(now) });

  if (row.status === 'denied') return { error: 'access_denied' };
  if (row.status === 'claimed') return { error: 'invalid_grant' };
  if (row.status === 'pending') {
    return { error: tooFast ? 'slow_down' : 'authorization_pending' };
  }

  // Approved: mint the token and burn the device code. Both writes commit
  // together so a crash can never leave a code that is spent but tokenless.
  const issued = await db.sequelize.transaction(async (transaction) => {
    const result = await issueDeviceToken(db, {
      userId: row.user_id,
      clientId: row.client_id,
      name: row.device_name,
      scopes: row.scopes,
      now,
      transaction,
    });
    await row.update({ status: 'claimed' }, { transaction });
    return result;
  });
  return { ok: true, ...tokenResponse(issued.accessToken, issued.refreshToken, issued.token) };
}

// Refresh rotates both halves: a leaked refresh token is only good until the
// device next uses its own.
export async function refreshDeviceToken(db, { refreshToken, clientId, now = Date.now() }) {
  const row = await db.models.DeviceToken.findOne({
    where: { refresh_token_hash: hashToken(refreshToken || '') },
  });
  if (!row || row.client_id !== clientId || row.revoked_at) return { error: 'invalid_grant' };
  const accessToken = generateToken();
  const nextRefresh = generateToken();
  await row.update({
    access_token_hash: hashToken(accessToken),
    refresh_token_hash: hashToken(nextRefresh),
    expires_at: new Date(now + ACCESS_TOKEN_TTL_MS),
  });
  return { ok: true, ...tokenResponse(accessToken, nextRefresh, row) };
}

// Resolves a bearer access token to its user. Returns null for unknown,
// expired or revoked tokens.
export async function getDeviceTokenUser(db, accessToken, { now = Date.now() } = {}) {
  if (!accessToken) return null;
  const row = await db.models.DeviceToken.findOne({
    where: { access_token_hash: hashToken(accessToken) },
    include: db.models.User,
  });
  if (!row || !row.User || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= now) return null;
  const { id, username, is_admin, must_change_password } = row.User;
  return {
    token: row,
    user: { id, username, is_admin, must_change_password },
  };
}

export async function touchDeviceToken(db, tokenId, { now = Date.now() } = {}) {
  await db.models.DeviceToken.update({ last_seen_at: new Date(now) }, { where: { id: tokenId } });
}

export async function revokeDeviceToken(db, { tokenId, userId, now = Date.now() }) {
  const where = { id: Number(tokenId) || 0 };
  if (userId !== undefined) where.user_id = userId;
  const row = await db.models.DeviceToken.findOne({ where });
  if (!row) return null;
  await row.update({ revoked_at: new Date(now), refresh_token_hash: null });
  return row;
}

// Revoke every live device token of a user at once. A password change or reset
// is meant to cut off access won with the old credential, and a bearer device
// token — which refreshes itself indefinitely without re-checking the password
// — would otherwise outlive it. Called in the same transaction as the password
// update so the two land together.
export async function revokeUserDeviceTokens(db, userId, { now = Date.now(), transaction = null } = {}) {
  return db.models.DeviceToken.update(
    { revoked_at: new Date(now), refresh_token_hash: null },
    { where: { user_id: userId, revoked_at: null }, transaction }
  );
}

// Housekeeping: lapsed device codes and long-dead tokens are of no further
// use to anyone.
export async function pruneDeviceAuth(db, { now = Date.now(), keepRevokedMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  await db.models.DeviceAuthorization.destroy({
    where: { expires_at: { [Op.lt]: new Date(now) } },
  });
  await db.models.DeviceToken.destroy({
    where: { revoked_at: { [Op.lt]: new Date(now - keepRevokedMs) } },
  });
}
