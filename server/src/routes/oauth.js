// The device-facing half of the OAuth device authorization grant. These are
// the only unauthenticated endpoints besides login: everything here is either
// anonymous by design (asking for a code pair) or authenticated by a
// credential the caller already holds (a device code, a refresh token).
//
// The user-facing half — approving a code — lives in routes/devices.js behind
// the session cookie, because approval must come from a logged-in browser.

import { Router } from 'express';
import express from 'express';
import { Op } from 'sequelize';
import {
  DEVICE_CODE_GRANT,
  claimDeviceToken,
  createDeviceAuthorization,
  findClient,
  hashToken,
  refreshDeviceToken,
  resolveScopes,
} from '../services/deviceAuth.js';

// RFC 8628 §3.5 error codes that mean "keep polling"; everything else is
// terminal for the app.
const OAUTH_ERROR_STATUS = {
  authorization_pending: 400,
  slow_down: 400,
  access_denied: 400,
  expired_token: 400,
  invalid_grant: 400,
  invalid_request: 400,
  unsupported_grant_type: 400,
  invalid_client: 401,
};

const ERROR_DESCRIPTIONS = {
  authorization_pending: 'The user has not approved this device yet.',
  slow_down: 'Polling too fast; wait for the advertised interval.',
  access_denied: 'The user denied this device.',
  expired_token: 'The device code has expired; start a new authorization.',
  invalid_grant: 'The device code or refresh token is not valid.',
  invalid_client: 'Unknown or disabled client_id.',
};

function oauthError(res, error, description) {
  return res
    .status(OAUTH_ERROR_STATUS[error] ?? 400)
    .json({ error, error_description: description || ERROR_DESCRIPTIONS[error] || undefined });
}

// The public base URL of this deployment, as the caller reached it. Behind
// nginx `trust proxy` makes req.protocol follow X-Forwarded-Proto, so this is
// the https:// URL when TLS is configured.
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

export function oauthRoutes(db, { verificationPath = '/link' } = {}) {
  const router = Router();
  // OAuth endpoints are specified as form-encoded; the app.js JSON parser
  // already ran, so this only adds the second content type.
  router.use(express.urlencoded({ extended: false }));

  // Step 1. Body: { client_id, scope?, device_name? }
  router.post('/device_authorization', async (req, res, next) => {
    try {
      const clientId = String(req.body?.client_id || '').trim();
      const client = await findClient(db, clientId);
      if (!client) return oauthError(res, 'invalid_client');

      const scopes = resolveScopes(req.body?.scope, client.scopes);
      if (scopes === null) {
        return oauthError(res, 'invalid_request', 'Requested scope exceeds the client registration.');
      }

      const deviceName = req.body?.device_name ? String(req.body.device_name).slice(0, 200) : null;
      const { authorization, deviceCode } = await createDeviceAuthorization(db, {
        clientId: client.client_id,
        scopes,
        deviceName,
      });

      const verificationUri = `${baseUrl(req)}${verificationPath}`;
      res.json({
        device_code: deviceCode,
        user_code: authorization.user_code,
        verification_uri: verificationUri,
        // The convenience form for a device that can open a browser or show
        // a QR code; the plain URI plus the code always works too.
        verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(
          authorization.user_code
        )}`,
        expires_in: Math.max(
          0,
          Math.floor((new Date(authorization.expires_at).getTime() - Date.now()) / 1000)
        ),
        interval: authorization.interval_seconds,
        scope: authorization.scopes,
      });
    } catch (e) {
      next(e);
    }
  });

  // Step 3 (and refresh). Body: { grant_type, client_id, device_code | refresh_token }
  router.post('/token', async (req, res, next) => {
    try {
      const grantType = String(req.body?.grant_type || '').trim();
      const clientId = String(req.body?.client_id || '').trim();
      const client = await findClient(db, clientId);
      if (!client) return oauthError(res, 'invalid_client');

      if (grantType === DEVICE_CODE_GRANT) {
        const result = await claimDeviceToken(db, {
          deviceCode: String(req.body?.device_code || ''),
          clientId: client.client_id,
        });
        if (result.error) return oauthError(res, result.error);
        const { ok, ...token } = result;
        return res.json(token);
      }

      if (grantType === 'refresh_token') {
        const result = await refreshDeviceToken(db, {
          refreshToken: String(req.body?.refresh_token || ''),
          clientId: client.client_id,
        });
        if (result.error) return oauthError(res, result.error);
        const { ok, ...token } = result;
        return res.json(token);
      }

      return oauthError(res, 'unsupported_grant_type', `${grantType || '(none)'} is not supported.`);
    } catch (e) {
      next(e);
    }
  });

  // A device retiring its own credential (RFC 7009-shaped). Revoking from the
  // other side — the user pulling the plug — is DELETE /api/devices/:id.
  router.post('/revoke', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '');
      if (!token) return oauthError(res, 'invalid_request', 'token is required');
      const hash = hashToken(token);
      const row = await db.models.DeviceToken.findOne({
        where: { [Op.or]: [{ access_token_hash: hash }, { refresh_token_hash: hash }] },
      });
      // RFC 7009: revocation of an unknown token is still a success.
      if (row && !row.revoked_at) {
        await row.update({ revoked_at: new Date(), refresh_token_hash: null });
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
