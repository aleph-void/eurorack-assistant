import { Router } from 'express';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  deleteUserSessions,
  emailProblem,
  hashPassword,
  normalizeEmail,
  passwordProblem,
  requireAuth,
  sessionCookieOptions,
  sessionUserJson,
  verifyPassword,
} from '../auth.js';
import { revokeUserDeviceTokens } from '../services/deviceAuth.js';
import { asyncHandler } from './asyncHandler.js';

export function authRoutes(db) {
  const router = Router();

  router.post('/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const user = await db.models.User.findOne({ where: { username } });
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const { token, expiresAt } = await createSession(db, user.id);
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), expires: expiresAt });
    res.json(sessionUserJson(user));
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.json({ ok: true });
  }));

  router.get('/me', requireAuth(db, { allowPasswordChange: true }), (req, res) => {
    res.json(req.user);
  });

  // Self-service password change: always requires the current password, and
  // is the only mutating endpoint reachable while must_change_password is set.
  router.post('/password', requireAuth(db, { allowPasswordChange: true }), asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res
        .status(400)
        .json({ error: 'current_password and new_password are required' });
    }
    const problem = passwordProblem(new_password, { label: 'new password' });
    if (problem) return res.status(400).json({ error: problem });
    const user = await db.models.User.findByPk(req.user.id);
    if (!user || !verifyPassword(String(current_password), user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    // The new password and the logout of every other browser (the session
    // making the change survives) land atomically.
    await db.sequelize.transaction(async (transaction) => {
      await user.update(
        {
          password_hash: hashPassword(String(new_password)),
          must_change_password: false,
        },
        { transaction }
      );
      await deleteUserSessions(db, user.id, {
        exceptToken: req.cookies?.[SESSION_COOKIE],
        transaction,
      });
      // A device (oscilloscope) bearer token refreshes itself forever and
      // never re-checks the password, so a change that logs out every other
      // browser must cut those off too — the user re-links the device once.
      await revokeUserDeviceTokens(db, user.id, { transaction });
    });
    res.json(sessionUserJson(user));
  }));

  // The address a password reset is sent to. Setting it is as good as
  // holding the password, so it takes the current password the way the
  // password change does, and is rate-limited with it (app.js). An empty
  // or null address takes the address away; one another account holds is a
  // 409 — the index says so too, but the check here names the reason.
  router.put('/email', requireAuth(db), asyncHandler(async (req, res) => {
    const { current_password } = req.body || {};
    if (!current_password) {
      return res.status(400).json({ error: 'current_password is required' });
    }
    const email = normalizeEmail(req.body?.email);
    if (email !== null) {
      const problem = emailProblem(email);
      if (problem) return res.status(400).json({ error: problem });
    }
    const user = await db.models.User.findByPk(req.user.id);
    if (!user || !verifyPassword(String(current_password), user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (email !== null && email !== user.email) {
      const taken = await db.models.User.findOne({ where: { email } });
      if (taken) return res.status(409).json({ error: 'Email already in use' });
    }
    await user.update({ email });
    res.json(sessionUserJson(user));
  }));

  return router;
}
