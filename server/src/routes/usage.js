// What the shared subscription has been spent on.
//
// A user sees their own standing, which is what they need to understand a
// refused request. An admin sees everybody's, which is what they need to
// decide whose allowance to change.

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { budgetStatus, getBudgetSettings, limitFor, usageByUser } from '../services/budgets.js';

export function usageRoutes(db) {
  const { LlmUsage, User } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Where the caller stands. Cheap enough to poll: one bounded select.
  router.get('/me', async (req, res, next) => {
    try {
      res.json(await budgetStatus(db, req.user));
    } catch (e) {
      next(e);
    }
  });

  router.get('/', requireAdmin(), async (req, res, next) => {
    try {
      const settings = await getBudgetSettings(db);
      const since = new Date(Date.now() - settings.windowMs);
      const totals = await usageByUser(db, since);
      const users = await User.findAll({
        attributes: ['id', 'username', 'is_admin', 'token_budget'],
        order: [['id', 'ASC']],
      });
      const rows = users.map((user) => {
        const spent = totals.get(user.id) ?? { tokens: 0, cost: 0, runs: 0 };
        const limit = limitFor(user, settings);
        return {
          id: user.id,
          username: user.username,
          is_admin: user.is_admin,
          token_budget: user.token_budget === null ? null : Number(user.token_budget),
          limit,
          unlimited: limit === 0,
          used: spent.tokens,
          cost_usd: spent.cost,
          runs: spent.runs,
          remaining: limit === 0 ? null : Math.max(0, limit - spent.tokens),
          exhausted: limit > 0 && spent.tokens >= limit,
        };
      });
      res.json({
        period: settings.period,
        window_ms: settings.windowMs,
        since: since.toISOString(),
        default_limit: settings.limit,
        users: rows,
        total_tokens: rows.reduce((sum, row) => sum + row.used, 0),
        total_cost_usd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
      });
    } catch (e) {
      next(e);
    }
  });

  // The individual runs behind those totals, newest first — the answer to
  // "what actually spent that", which a per-user total cannot give.
  router.get('/runs', requireAdmin(), async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const runs = await LlmUsage.findAll({
        order: [['id', 'DESC']],
        limit,
        include: [{ model: User, attributes: ['id', 'username'] }],
      });
      res.json(
        runs.map((run) => ({
          ...run.get({ plain: true }),
          username: run.User?.username ?? null,
          User: undefined,
        }))
      );
    } catch (e) {
      next(e);
    }
  });

  return router;
}
