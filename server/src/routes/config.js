import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { getConfig, setConfig } from '../services/config.js';
import { PROVIDERS, KNOWN_MODELS, DEFAULT_MODELS } from '../services/llm.js';

export function configRoutes(db) {
  const router = Router();
  router.use(requireAuth(db), requireAdmin());

  router.get('/', async (req, res, next) => {
    try {
      const config = await getConfig(db);
      res.json({
        ...config,
        providers: PROVIDERS,
        known_models: KNOWN_MODELS,
        default_models: DEFAULT_MODELS,
      });
    } catch (e) {
      next(e);
    }
  });

  router.put('/', async (req, res, next) => {
    try {
      const updates = {};
      if (req.body?.llm_provider !== undefined) updates.llm_provider = req.body.llm_provider;
      if (req.body?.llm_model !== undefined) updates.llm_model = req.body.llm_model;
      if (req.body?.import_workers !== undefined) updates.import_workers = req.body.import_workers;
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
      }
      const config = await setConfig(db, updates);
      res.json(config);
    } catch (e) {
      if (/Invalid llm_provider|Invalid import_workers|Unknown config key/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  return router;
}
