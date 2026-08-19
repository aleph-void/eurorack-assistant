import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { getConfig, setConfig } from '../services/config.js';
import { PROVIDERS, KNOWN_MODELS, DEFAULT_MODELS } from '../services/llm.js';
import { asyncHandler } from './asyncHandler.js';

export function configRoutes(db) {
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
