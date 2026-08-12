// The user-facing half of device linking: approving a code an application is
// waiting on, seeing what is connected, and cutting one off.
//
// Everything here is session-authenticated — approval has to come from a
// logged-in browser, which is the whole security argument for the device
// grant. Device tokens are deliberately not accepted.

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  decideDeviceAuthorization,
  findPendingAuthorization,
  revokeDeviceToken,
} from '../services/deviceAuth.js';

export function deviceRoutes(db, { hub = null } = {}) {
  const { DeviceToken, OAuthClient } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const tokenJson = (token, connections) => ({
    id: token.id,
    name: token.name,
    client_id: token.client_id,
    scopes: token.scopes,
    created_at: token.created_at,
    expires_at: token.expires_at,
    last_seen_at: token.last_seen_at,
    revoked_at: token.revoked_at,
    connections: connections.filter((c) => c.token_id === token.id),
  });

  // Every credential the user has issued, with whatever is live on it.
  router.get('/', async (req, res, next) => {
    try {
      const tokens = await DeviceToken.findAll({
        where: { user_id: req.user.id, revoked_at: null },
        order: [['id', 'DESC']],
      });
      const connections = hub ? hub.list(req.user.id) : [];
      res.json(tokens.map((t) => tokenJson(t, connections)));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const revoked = await revokeDeviceToken(db, {
        tokenId: req.params.id,
        userId: req.user.id,
      });
      if (!revoked) return res.status(404).json({ error: 'Device not found' });
      // A revoked token must not keep a socket it already opened.
      if (hub) hub.closeToken(revoked.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // What the user is being asked to approve. 404 covers unknown, expired and
  // already-decided codes alike — there is nothing useful to distinguish.
  router.get('/authorizations/:code', async (req, res, next) => {
    try {
      const row = await findPendingAuthorization(db, req.params.code);
      if (!row) return res.status(404).json({ error: 'That code is not valid or has expired' });
      const client = await OAuthClient.findOne({ where: { client_id: row.client_id } });
      res.json({
        user_code: row.user_code,
        client_id: row.client_id,
        client_name: client?.name ?? row.client_id,
        device_name: row.device_name,
        scopes: row.scopes,
        expires_at: row.expires_at,
      });
    } catch (e) {
      next(e);
    }
  });

  // Body: { name? } — what to call this device in the list.
  router.post('/authorizations/:code/approve', async (req, res, next) => {
    try {
      const name = req.body?.name ? String(req.body.name).trim().slice(0, 120) : null;
      const row = await decideDeviceAuthorization(db, {
        userCode: req.params.code,
        userId: req.user.id,
        approve: true,
        name,
      });
      if (!row) return res.status(404).json({ error: 'That code is not valid or has expired' });
      res.json({ ok: true, user_code: row.user_code, device_name: row.device_name });
    } catch (e) {
      next(e);
    }
  });

  router.post('/authorizations/:code/deny', async (req, res, next) => {
    try {
      const row = await decideDeviceAuthorization(db, {
        userCode: req.params.code,
        userId: req.user.id,
        approve: false,
      });
      if (!row) return res.status(404).json({ error: 'That code is not valid or has expired' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
