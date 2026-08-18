// Per-user LLM provider accounts and settings: which provider a user's jobs
// run on, and the credentials they run with (services/llmAccounts.js). All
// of it is self-service — each row belongs to the logged-in user and no
// admin can read a credential back out.

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getLlmSettings, userJobModels } from '../services/config.js';
import { PROVIDERS, KNOWN_MODELS, DEFAULT_MODELS, LLM_JOB_TYPES } from '../services/llm.js';
import {
  accountSummary,
  beginClaudeOauth,
  clearAccountPause,
  deleteAccount,
  finishClaudeOauth,
  getAccount,
  saveApiKey,
  saveClaudeToken,
  saveCodexAuthJson,
} from '../services/llmAccounts.js';

// A started authorization is only good for so long; a verifier that sat
// around for an hour is a flow the user abandoned.
const OAUTH_PENDING_TTL_MS = 60 * 60 * 1000;

export function llmRoutes(db, { fetchImpl = fetch, oauth = undefined } = {}) {
  const router = Router();
  router.use(requireAuth(db));

  // In-flight Claude authorizations, by user id. In memory on purpose: a
  // PKCE verifier is worthless after the exchange and short-lived before it,
  // and the server is a single process.
  const pendingOauth = new Map();

  const summarize = async (userId) => {
    const accounts = {};
    for (const provider of PROVIDERS) {
      accounts[provider] = accountSummary(await getAccount(db, userId, provider));
    }
    return accounts;
  };

  const status = async (user) => {
    const settings = await getLlmSettings(db, null, user);
    return {
      llm_provider: user.llm_provider || '',
      llm_model: user.llm_model || '',
      llm_models: userJobModels(user),
      effective_provider: settings.provider,
      effective_model: settings.model,
      providers: PROVIDERS,
      known_models: KNOWN_MODELS,
      default_models: DEFAULT_MODELS,
      llm_job_types: LLM_JOB_TYPES,
      accounts: await summarize(user.id),
    };
  };

  router.get('/', async (req, res, next) => {
    try {
      res.json(await status(req.user));
    } catch (e) {
      next(e);
    }
  });

  // The user's own provider/model choice. Blank means "whatever the admin
  // configured", which is also what every account starts as.
  router.put('/settings', async (req, res, next) => {
    try {
      const updates = {};
      if (req.body?.llm_provider !== undefined) {
        const provider = String(req.body.llm_provider).trim();
        if (provider !== '' && !PROVIDERS.includes(provider)) {
          return res.status(400).json({ error: `Invalid llm_provider: ${provider}` });
        }
        updates.llm_provider = provider;
      }
      if (req.body?.llm_model !== undefined) {
        updates.llm_model = String(req.body.llm_model).trim().slice(0, 200);
      }
      if (req.body?.llm_models !== undefined) {
        const given = req.body.llm_models;
        if (!given || typeof given !== 'object' || Array.isArray(given)) {
          return res.status(400).json({ error: 'llm_models must be an object of job type → model' });
        }
        const models = {};
        for (const [type, model] of Object.entries(given)) {
          if (!LLM_JOB_TYPES.includes(type)) {
            return res.status(400).json({ error: `Unknown job type: ${type}` });
          }
          const value = String(model ?? '').trim().slice(0, 200);
          if (value) models[type] = value; // blank means "no override"
        }
        updates.llm_models = JSON.stringify(models);
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
      }
      await db.models.User.update(updates, { where: { id: req.user.id } });
      Object.assign(req.user, updates);
      res.json(await status(req.user));
    } catch (e) {
      next(e);
    }
  });

  // Claude, step 1: mint the authorization URL the user opens in their own
  // browser. Approving there shows them a code to paste back into step 2.
  router.post('/claude/oauth/start', async (req, res, next) => {
    try {
      const { url, verifier } = beginClaudeOauth(oauth ? { oauth } : {});
      pendingOauth.set(req.user.id, { verifier, at: Date.now() });
      res.json({ url });
    } catch (e) {
      next(e);
    }
  });

  // Claude, step 2: exchange the pasted code for tokens and keep them.
  router.post('/claude/oauth/finish', async (req, res, next) => {
    try {
      const pending = pendingOauth.get(req.user.id);
      if (!pending || Date.now() - pending.at > OAUTH_PENDING_TTL_MS) {
        pendingOauth.delete(req.user.id);
        return res
          .status(400)
          .json({ error: 'No authorization in progress — start the authorization again' });
      }
      await finishClaudeOauth(db, req.user.id, req.body?.code, pending.verifier, {
        fetchImpl,
        ...(oauth ? { oauth } : {}),
      });
      pendingOauth.delete(req.user.id);
      res.json(await status(req.user));
    } catch (e) {
      if (/^(Invalid|No authorization|Anthropic token endpoint)/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  // Claude, the offline path: a long-lived token from `claude setup-token`.
  router.post('/claude/token', async (req, res, next) => {
    try {
      await saveClaudeToken(db, req.user.id, req.body?.token);
      res.json(await status(req.user));
    } catch (e) {
      if (/^Invalid/.test(e.message)) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  // Codex: the auth.json a `codex login` wrote on the user's own machine.
  router.post('/codex/auth-json', async (req, res, next) => {
    try {
      await saveCodexAuthJson(db, req.user.id, req.body?.auth_json);
      res.json(await status(req.user));
    } catch (e) {
      if (/^Invalid/.test(e.message)) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  // Either provider: a plain API key.
  router.post('/:provider/api-key', async (req, res, next) => {
    try {
      await saveApiKey(db, req.user.id, req.params.provider, req.body?.api_key);
      res.json(await status(req.user));
    } catch (e) {
      if (/^Invalid/.test(e.message)) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  // Lift a quota pause by hand — the stored reset time is the provider's
  // word, not gospel.
  router.post('/:provider/resume', async (req, res, next) => {
    try {
      if (!PROVIDERS.includes(req.params.provider)) {
        return res.status(400).json({ error: `Invalid provider: ${req.params.provider}` });
      }
      await clearAccountPause(db, req.user.id, req.params.provider);
      res.json(await status(req.user));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:provider', async (req, res, next) => {
    try {
      if (!PROVIDERS.includes(req.params.provider)) {
        return res.status(400).json({ error: `Invalid provider: ${req.params.provider}` });
      }
      await deleteAccount(db, req.user.id, req.params.provider);
      res.json(await status(req.user));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
