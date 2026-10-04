import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { getConfig, setConfig } from '../services/config.js';
import { getMailConfig, mailConfigJson, setMailConfig } from '../services/mailConfig.js';
import { sendMail } from '../services/mailer.js';
import { PROVIDERS, KNOWN_MODELS, DEFAULT_MODELS } from '../services/llm.js';
import { asyncHandler } from './asyncHandler.js';

export function configRoutes(db, { mailImpl } = {}) {
  const router = Router();
  router.use(requireAuth(db), requireAdmin());

  // The mail server (services/mailConfig.js): its own pair of routes because
  // its one secret is served masked, where the rest of the config is served
  // as stored.
  router.get('/mail', asyncHandler(async (req, res) => {
    res.json(mailConfigJson(await getMailConfig(db)));
  }));

  router.put('/mail', async (req, res, next) => {
    try {
      const config = await setMailConfig(db, req.body || {});
      res.json(mailConfigJson(config));
    } catch (e) {
      if (/^(Invalid|Unknown mail setting|Nothing to update)/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  // A test mail to the admin's own address, so the settings are proved
  // before a user is left waiting on a confirmation that never comes.
  router.post('/mail/test', asyncHandler(async (req, res) => {
    const result = await sendMail(
      db,
      {
        to: req.user.email,
        subject: 'Eurorack Assistant test mail',
        text: 'If you are reading this, the mail server settings work.',
      },
      { mailImpl }
    );
    if (!result.sent) return res.status(502).json({ error: result.problem });
    res.json({ ok: true, to: req.user.email });
  }));

  router.get('/', asyncHandler(async (req, res) => {
    const config = await getConfig(db);
    res.json({
      ...config,
      providers: PROVIDERS,
      known_models: KNOWN_MODELS,
      default_models: DEFAULT_MODELS,
    });
  }));

  router.put('/', async (req, res, next) => {
    try {
      const updates = {};
      const allowed = [
        'llm_provider',
        'llm_model',
        'import_workers',
        'token_budget_default',
        'token_budget_period',
        'youtube_api_key',
      ];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) updates[key] = req.body[key];
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
      }
      const config = await setConfig(db, updates);
      res.json(config);
    } catch (e) {
      if (/^(Invalid|Unknown config key)/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  return router;
}
