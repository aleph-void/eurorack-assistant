import { Router } from 'express';
import { hashPassword, generatePassword, requireAuth, requireAdmin } from '../auth.js';

export function userRoutes(db) {
  const router = Router();
  router.use(requireAuth(db), requireAdmin());

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT id, username, is_admin, created_at FROM users ORDER BY id'
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // Admins create non-admin users only. If no password is given, one is
  // generated and returned once in the response (stored only as a hash).
  router.post('/', async (req, res, next) => {
    try {
      const { username } = req.body || {};
      let { password } = req.body || {};
      if (!username || !/^[a-zA-Z0-9._-]{2,64}$/.test(username)) {
        return res.status(400).json({
          error: 'username is required (2-64 chars: letters, digits, . _ -)',
        });
      }
      const { rows: existing } = await db.query(
        'SELECT id FROM users WHERE lower(username) = lower($1)',
        [username]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      let generated = null;
      if (!password) {
        generated = generatePassword();
        password = generated;
      } else if (String(password).length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters' });
      }
      const { rows } = await db.query(
        `INSERT INTO users (username, password_hash, is_admin)
         VALUES ($1, $2, FALSE) RETURNING id, username, is_admin, created_at`,
        [username, hashPassword(String(password))]
      );
      const user = rows[0];
      res.status(201).json(generated ? { ...user, generated_password: generated } : user);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (id === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }
      const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
