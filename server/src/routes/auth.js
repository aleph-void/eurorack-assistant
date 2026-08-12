import { Router } from 'express';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getSessionUser,
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
      const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
      if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const user = rows[0];
      const { token, expiresAt } = await createSession(db, user.id);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        expires: expiresAt,
      });
      res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
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

  router.get('/me', requireAuth(db), (req, res) => {
    res.json(req.user);
  });

  return router;
}
