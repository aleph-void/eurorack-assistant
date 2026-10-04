import { Router } from 'express';
import { fn, col, where } from 'sequelize';
import {
  deleteUserSessions,
  emailProblem,
  generatePassword,
  hashPassword,
  normalizeEmail,
  passwordProblem,
  requireAdmin,
  requireAuth,
} from '../auth.js';
import { purgeUserLlmData } from '../services/llmAccounts.js';
import { revokeUserDeviceTokens } from '../services/deviceAuth.js';
import { userSystemsSummary } from '../services/systemTransfer.js';
import { lockUser, unlockUser } from '../services/accountLock.js';
import { startEmailVerification } from '../services/emailVerification.js';
import { sendMail } from '../services/mailer.js';
import { asyncHandler } from './asyncHandler.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);

function publicUser(user) {
  const {
    id,
    username,
    email,
    email_verified_at,
    is_admin,
    created_at,
    token_budget,
    locked_at,
    locked_reason,
    failed_logins,
    last_login_at,
  } = user;
  return {
    id,
    username,
    email,
    email_verified_at: iso(email_verified_at),
    is_admin,
    created_at,
    locked_at: iso(locked_at),
    locked_reason: locked_reason ?? null,
    failed_logins: Number(failed_logins || 0),
    last_login_at: iso(last_login_at),
    // BIGINT arrives from postgres as a string; the API says numbers.
    token_budget: token_budget === null || token_budget === undefined ? null : Number(token_budget),
  };
}

export function userRoutes(db, { mailImpl } = {}) {
  const { User } = db.models;
  const router = Router();
  router.use(requireAuth(db), requireAdmin());
  const mail = (message) => sendMail(db, message, { mailImpl });

  router.get('/', asyncHandler(async (req, res) => {
    const users = await User.findAll({
      attributes: [
        'id',
        'username',
        'email',
        'email_verified_at',
        'is_admin',
        'created_at',
        'token_budget',
        'locked_at',
        'locked_reason',
        'failed_logins',
        'last_login_at',
      ],
      order: [['id', 'ASC']],
    });
    res.json(users.map(publicUser));
  }));

  // Admins create non-admin users only. If no password is given, one is
  // generated and returned once in the response (stored only as a hash).
  // The address is required and starts unconfirmed: the confirmation mail
  // goes out as the account is made.
  router.post('/', asyncHandler(async (req, res) => {
    const { username } = req.body || {};
    let { password } = req.body || {};
    if (!username || !/^[a-zA-Z0-9._-]{2,64}$/.test(username)) {
      return res.status(400).json({
        error: 'username is required (2-64 chars: letters, digits, . _ -)',
      });
    }
    const email = normalizeEmail(req.body?.email);
    const emailTrouble = emailProblem(email ?? '');
    if (emailTrouble) return res.status(400).json({ error: emailTrouble });
    const existing = await User.findOne({
      where: where(fn('lower', col('username')), String(username).toLowerCase()),
    });
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    if (await User.findOne({ where: { email } })) {
      return res.status(409).json({ error: 'Email already in use' });
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
      email,
      password_hash: hashPassword(String(password)),
      is_admin: false,
    });
    const verification = await startEmailVerification(db, created, { sendMail: mail });
    const user = { ...publicUser(created), verification };
    res.status(201).json(generated ? { ...user, generated_password: generated } : user);
  }));

  // The admin putting right a user's address. Whatever was confirmed was the
  // old one, so the new one starts unconfirmed and the mail goes out again.
  // The admin's own address is changed on the account page, with a password.
  router.put('/:id/email', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Use the account page to change your own address' });
    }
    const user = await User.findByPk(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const email = normalizeEmail(req.body?.email);
    const problem = emailProblem(email ?? '');
    if (problem) return res.status(400).json({ error: problem });
    if (email !== user.email && (await User.findOne({ where: { email } }))) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    await user.update({ email, email_verified_at: null });
    const verification = await startEmailVerification(db, user, { sendMail: mail });
    res.json({ ...publicUser(user), verification });
  }));

  // Shutting an account, and opening it again — the latter also for one the
  // failed-login rule shut. Locking logs the user out everywhere.
  router.put('/:id/lock', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot lock your own account' });
    }
    if (typeof req.body?.locked !== 'boolean') {
      return res.status(400).json({ error: 'locked must be true or false' });
    }
    const user = await User.findByPk(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.body.locked) await lockUser(db, user, { reason: 'admin' });
    else await unlockUser(db, user);
    res.json(publicUser(user));
  }));

  // Admins reset another user's password without knowing the current one.
  // If no password is given, one is generated and returned once. The user is
  // logged out everywhere and must pick their own password at the next login.
  router.post('/:id/password', asyncHandler(async (req, res) => {
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
      // An admin reset is the incident-response path; a device bearer token
      // that refreshes itself indefinitely would otherwise survive it.
      await revokeUserDeviceTokens(db, user.id, { transaction });
    });
    const result = { ok: true, username: user.username };
    res.json(generated ? { ...result, generated_password: generated } : result);
  }));

  // This user's token allowance per budget window. null hands them back the
  // configured default; 0 lifts the ceiling for them alone. Admins are exempt
  // from budgets either way, so setting one on an admin records an intention
  // and changes nothing.
  router.put('/:id/budget', asyncHandler(async (req, res) => {
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
  }));

  // This user's systems, each with how much hangs off it — what an admin
  // picks from before handing one to another user
  // (POST /api/systems/:id/transfer).
  router.get('/:id/systems', asyncHandler(async (req, res) => {
    const user = await User.findByPk(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(await userSystemsSummary(db, user.id));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const deleted = await User.destroy({ where: { id } });
    if (deleted === 0) return res.status(404).json({ error: 'User not found' });
    // The DB rows cascade; the credentials materialized on the data volume
    // do not, so erase those too — otherwise a deleted user's provider
    // tokens linger in cleartext on disk.
    purgeUserLlmData(id);
    res.json({ ok: true });
  }));

  return router;
}
