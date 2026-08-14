// Per-user spending limits on the shared LLM subscription.
//
// The unit is tokens, not money. Only one of the two provider CLIs reports a
// cost, and on a subscription login that cost is a list-price comparison
// rather than an amount anybody is charged — but both CLIs report tokens, so
// tokens are the thing every user can be measured in and held to.
//
// The window is rolling rather than calendar: "the last 24 hours", not "since
// midnight". A calendar window hands everybody a full allowance at the same
// instant and encourages a race for it; a rolling one lets a user who spent
// heavily this morning start working again tomorrow morning, which is the
// behaviour people expect from a quota anyway.
//
// Admins are exempt. An admin who has spent their allowance cannot raise it
// through a web app that will not run the job that renders the page.

import { Op } from 'sequelize';
import { getConfig } from './config.js';

export const BUDGET_PERIODS = {
  day: { label: 'day', ms: 24 * 60 * 60 * 1000 },
  week: { label: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  month: { label: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
};

export const DEFAULT_BUDGET_PERIOD = 'month';

export function periodMs(period) {
  return (BUDGET_PERIODS[period] ?? BUDGET_PERIODS[DEFAULT_BUDGET_PERIOD]).ms;
}

// The admin's settings, normalized. `limit` of 0 means nobody has a ceiling
// unless one was set on them by hand, which is the shipped default: an app
// that starts refusing work the day it is installed is not a nice surprise.
export async function getBudgetSettings(db) {
  const config = await getConfig(db);
  const raw = Number(config.token_budget_default);
  const period = BUDGET_PERIODS[config.token_budget_period]
    ? config.token_budget_period
    : DEFAULT_BUDGET_PERIOD;
  return {
    limit: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0,
    period,
    windowMs: periodMs(period),
  };
}

// The ceiling that applies to one user: their own if they have one, otherwise
// the default. 0 (either way) means unlimited.
export function limitFor(user, settings) {
  if (!user || user.is_admin) return 0;
  const own =
    user.token_budget === null || user.token_budget === undefined
      ? null
      : Number(user.token_budget);
  if (own !== null && Number.isFinite(own)) return own > 0 ? own : 0;
  return settings.limit;
}

// Tokens spent per user since `since`, as a Map of user id to total.
//
// Summed in JS rather than with GROUP BY: the rows are small, the window is
// bounded, and the test database (pg-mem) is happier with a plain select than
// with an aggregate it has to reimplement.
export async function usageByUser(db, since) {
  const rows = await db.models.LlmUsage.findAll({
    attributes: ['user_id', 'total_tokens', 'cost_usd'],
    where: { created_at: { [Op.gte]: since } },
  });
  const totals = new Map();
  for (const row of rows) {
    if (row.user_id === null || row.user_id === undefined) continue;
    const running = totals.get(row.user_id) ?? { tokens: 0, cost: 0, runs: 0 };
    running.tokens += Number(row.total_tokens) || 0;
    running.cost += Number(row.cost_usd) || 0;
    running.runs += 1;
    totals.set(row.user_id, running);
  }
  return totals;
}

// Where one user stands. `exhausted` is the only field callers need to act on;
// the rest is for telling them why.
export async function budgetStatus(db, user, now = Date.now()) {
  const settings = await getBudgetSettings(db);
  const limit = limitFor(user, settings);
  const since = new Date(now - settings.windowMs);
  const spent = (await usageByUser(db, since)).get(user.id) ?? { tokens: 0, cost: 0, runs: 0 };
  return {
    period: settings.period,
    window_ms: settings.windowMs,
    since: since.toISOString(),
    limit,
    unlimited: limit === 0,
    used: spent.tokens,
    cost_usd: spent.cost,
    runs: spent.runs,
    remaining: limit === 0 ? null : Math.max(0, limit - spent.tokens),
    exhausted: limit > 0 && spent.tokens >= limit,
  };
}

// The users who have nothing left, as a Set of ids. Empty — without touching
// the usage table at all — when no budget is in force anywhere, which is the
// state an app that never configures one stays in forever.
export async function exhaustedUserIds(db, now = Date.now()) {
  const settings = await getBudgetSettings(db);
  const users = await db.models.User.findAll({
    attributes: ['id', 'is_admin', 'token_budget'],
  });
  const limits = new Map();
  for (const user of users) {
    const limit = limitFor(user, settings);
    if (limit > 0) limits.set(user.id, limit);
  }
  if (limits.size === 0) return new Set();

  const totals = await usageByUser(db, new Date(now - settings.windowMs));
  const exhausted = new Set();
  for (const [userId, limit] of limits) {
    if ((totals.get(userId)?.tokens ?? 0) >= limit) exhausted.add(userId);
  }
  return exhausted;
}

// Record what a run spent. Never throws: the tokens are gone whether or not
// the row lands, and a failed insert must not fail the job that earned it.
export async function recordUsage(db, usage, { userId = null, jobId = null, jobType = null } = {}) {
  if (!usage) return null;
  try {
    return await db.models.LlmUsage.create({
      user_id: userId,
      job_id: jobId,
      job_type: jobType,
      provider: usage.provider,
      model: usage.model ?? null,
      input_tokens: usage.input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_tokens ?? 0,
      cache_write_tokens: usage.cache_write_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cost_usd: usage.cost_usd ?? null,
    });
  } catch {
    return null;
  }
}

// Express guard for the routes that start LLM work. A user out of tokens is
// told so when they ask for more, rather than watching a job sit in the queue
// and wondering: the queue holds their work too (jobs/worker.js), but silence
// is not an explanation.
export function requireBudget(db) {
  return async (req, res, next) => {
    try {
      const status = await budgetStatus(db, req.user);
      if (!status.exhausted) {
        req.budget = status;
        return next();
      }
      res.status(429).json({
        error:
          `Token budget spent: ${status.used.toLocaleString()} of ` +
          `${status.limit.toLocaleString()} tokens in the last ${status.period}. ` +
          `Work already queued waits; new work can be started as the window rolls forward.`,
        budget: status,
      });
    } catch (e) {
      next(e);
    }
  };
}
