import { Router } from 'express';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  requireAuth,
  verifyPassword,
} from '../auth.js';

export function authRoutes(db) {
  const router = Router();

  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }
      const user = await db.models.User.findOne({ where: { username } });
      if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const { token, expiresAt } = await createSession(db, user.id);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        expires: expiresAt,
      });
      res.json({
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        must_change_password: user.must_change_password,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) await deleteSession(db, token);
      res.clearCookie(SESSION_COOKIE);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.get('/me', requireAuth(db, { allowPasswordChange: true }), (req, res) => {
    res.json(req.user);
  });

  // Self-service password change: always requires the current password, and
  // is the only mutating endpoint reachable while must_change_password is set.
  router.post('/password', requireAuth(db, { allowPasswordChange: true }), async (req, res, next) => {
    try {
      const { current_password, new_password } = req.body || {};
      if (!current_password || !new_password) {
        return res
          .status(400)
          .json({ error: 'current_password and new_password are required' });
      }
      if (String(new_password).length < 8) {
        return res.status(400).json({ error: 'new password must be at least 8 characters' });
      }
      const user = await db.models.User.findByPk(req.user.id);
      if (!user || !verifyPassword(String(current_password), user.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      await user.update({
        password_hash: hashPassword(String(new_password)),
        must_change_password: false,
      });
      // Log out every other browser; the session making the change survives.
      await deleteUserSessions(db, user.id, { exceptToken: req.cookies?.[SESSION_COOKIE] });
      res.json({
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        must_change_password: false,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
