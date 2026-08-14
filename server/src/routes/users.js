import { Router } from 'express';
import { fn, col, where } from 'sequelize';
import {
  deleteUserSessions,
  generatePassword,
  hashPassword,
  passwordProblem,
  requireAdmin,
  requireAuth,
} from '../auth.js';

function publicUser(user) {
  const { id, username, is_admin, created_at, token_budget } = user;
  return {
    id,
    username,
    is_admin,
    created_at,
    // BIGINT arrives from postgres as a string; the API says numbers.
    token_budget: token_budget === null || token_budget === undefined ? null : Number(token_budget),
  };
}

export function userRoutes(db) {
  const { User } = db.models;
  const router = Router();
  router.use(requireAuth(db), requireAdmin());

  router.get('/', async (req, res, next) => {
    try {
      const users = await User.findAll({
        attributes: ['id', 'username', 'is_admin', 'created_at', 'token_budget'],
        order: [['id', 'ASC']],
      });
      res.json(users.map(publicUser));
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
      const existing = await User.findOne({
        where: where(fn('lower', col('username')), String(username).toLowerCase()),
      });
      if (existing) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      let generated = null;
      if (!password) {
        generated = generatePassword();
        password = generated;
      } else {
        const problem = passwordProblem(password);
        if (problem) return res.status(400).json({ error: problem });
      }
      const created = await User.create({
        username,
        password_hash: hashPassword(String(password)),
        is_admin: false,
      });
      const user = publicUser(created);
      res.status(201).json(generated ? { ...user, generated_password: generated } : user);
    } catch (e) {
      next(e);
    }
  });

  // Admins reset another user's password without knowing the current one.
  // If no password is given, one is generated and returned once. The user is
  // logged out everywhere and must pick their own password at the next login.
  router.post('/:id/password', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (id === req.user.id) {
        return res
          .status(400)
          .json({ error: 'Use the change-password form to change your own password' });
      }
      const user = await User.findByPk(id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      let { password } = req.body || {};
      let generated = null;
      if (!password) {
        generated = generatePassword();
        password = generated;
      } else {
        const problem = passwordProblem(password);
        if (problem) return res.status(400).json({ error: problem });
      }
      // The reset and the forced logout everywhere land atomically.
      await db.sequelize.transaction(async (transaction) => {
        await user.update(
          {
            password_hash: hashPassword(String(password)),
            must_change_password: true,
          },
          { transaction }
        );
        await deleteUserSessions(db, user.id, { transaction });
      });
      const result = { ok: true, username: user.username };
      res.json(generated ? { ...result, generated_password: generated } : result);
    } catch (e) {
      next(e);
    }
  });

  // This user's token allowance per budget window. null hands them back the
  // configured default; 0 lifts the ceiling for them alone. Admins are exempt
  // from budgets either way, so setting one on an admin records an intention
  // and changes nothing.
  router.put('/:id/budget', async (req, res, next) => {
    try {
      const user = await User.findByPk(Number(req.params.id));
      if (!user) return res.status(404).json({ error: 'User not found' });
      const raw = req.body?.token_budget;
      let budget = null;
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          return res
            .status(400)
            .json({ error: 'token_budget must be a whole number of tokens (0 = no limit)' });
        }
        budget = n;
      }
      await user.update({ token_budget: budget });
      res.json(publicUser(user));
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
      const deleted = await User.destroy({ where: { id } });
      if (deleted === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
