import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { getConfig, setConfig } from '../services/config.js';
import { PROVIDERS, KNOWN_MODELS, DEFAULT_MODELS } from '../services/llm.js';
import { mailConfigured, sendAlertMail } from '../services/mail.js';
import { asyncHandler } from './asyncHandler.js';

export function configRoutes(db, { sendMailImpl = null } = {}) {
  const router = Router();
  router.use(requireAuth(db), requireAdmin());

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
        'smtp_url',
        'smtp_from',
        'alert_email',
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

  // A message to the alert address through the SAVED mail settings, so the
  // admin learns that the server refuses the login today rather than on the
  // night a backup fails. The SMTP server's own refusal is the useful part
  // of the answer, so it is passed on in the error.
  router.post('/mail-test', async (req, res, next) => {
    try {
      const config = await getConfig(db);
      if (!mailConfigured(config)) {
        return res.status(400).json({
          error: 'Save an SMTP URL and an alert address first; the test uses the saved settings.',
        });
      }
      const result = await sendAlertMail(
        config,
        {
          subject: '[Eurorack Assistant] Test message',
          text: 'This is the test message from Application Config → Alerts. If you are reading it, a failed backup will reach you the same way.',
        },
        { sendMailImpl }
      );
      res.json(result);
    } catch (e) {
      // A refused login, an unknown host, a timeout: the admin's to fix,
      // not a server error.
      if (e && typeof e.message === 'string') {
        return res.status(502).json({ error: `Could not send: ${e.message}` });
      }
      next(e);
    }
  });

  return router;
}
