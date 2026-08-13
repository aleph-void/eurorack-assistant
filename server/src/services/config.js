import { PROVIDERS, DEFAULT_MODELS, LLM_JOB_TYPES } from './llm.js';

export const CONFIG_DEFAULTS = {
  llm_provider: 'claude',
  llm_model: '',
  import_workers: '4',
  // Queue pause, set by the worker when the provider reports the
  // subscription is out of tokens: an ISO timestamp the queue is asleep
  // until, and the message that put it there. Blank while the queue runs.
  // Not admin-editable through the config route — the jobs route resumes it.
  queue_paused_until: '',
  queue_paused_reason: '',
  // Per-job-type model overrides (llm_model_find_manual, ...); blank falls
  // back to the global llm_model.
  ...Object.fromEntries(LLM_JOB_TYPES.map((type) => [`llm_model_${type}`, ''])),
};

export const DEFAULT_IMPORT_WORKERS = Number(CONFIG_DEFAULTS.import_workers);

export async function getConfig(db) {
  const rows = await db.models.AppConfig.findAll();
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) config[row.key] = row.value;
  return config;
}

export async function setConfig(db, updates) {
  const { AppConfig } = db.models;
  for (const [key, rawValue] of Object.entries(updates)) {
    if (!(key in CONFIG_DEFAULTS)) throw new Error(`Unknown config key: ${key}`);
    let value = rawValue;
    if (key === 'llm_provider' && !PROVIDERS.includes(value)) {
      throw new Error(`Invalid llm_provider: ${value}`);
    }
    if (key === 'queue_paused_until' && String(value).trim() !== '') {
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) throw new Error(`Invalid queue_paused_until: ${value}`);
      value = at.toISOString();
    }
    if (key === 'import_workers') {
      const n = Number(value);
      if (typeof value === 'boolean' || String(value).trim() === '' || !Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid import_workers: must be an integer of at least 1`);
      }
      value = n; // normalize '4.0e0'-style inputs to the plain integer
    }
    const [updated] = await AppConfig.update({ value: String(value) }, { where: { key } });
    if (updated === 0) {
      await AppConfig.create({ key, value: String(value) });
    }
  }
  return getConfig(db);
}

// Number of concurrent job workers, from app_config. Falls back to the
// default if the stored value is missing or unusable.
export async function getImportWorkerCount(db) {
  const config = await getConfig(db);
  const n = Number(config.import_workers);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_IMPORT_WORKERS;
}

// State of the global queue pause. `paused` is the only thing callers should
// act on; `expired` says a pause was stored but its time has come, which is
// the worker's cue to clear the keys and announce that the queue is back.
export async function getQueuePause(db, now = Date.now()) {
  const config = await getConfig(db);
  const raw = String(config.queue_paused_until || '').trim();
  const until = raw ? new Date(raw) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return { paused: false, expired: false, until: null, reason: '' };
  }
  const paused = until.getTime() > now;
  return {
    paused,
    expired: !paused,
    until: until.toISOString(),
    reason: config.queue_paused_reason || '',
  };
}

export const pauseQueue = (db, { until, reason = '' }) =>
  setConfig(db, {
    queue_paused_until: new Date(until).toISOString(),
    queue_paused_reason: reason,
  });

export const resumeQueue = (db) =>
  setConfig(db, { queue_paused_until: '', queue_paused_reason: '' });

// Provider/model pair for creating an LLM backend. Resolution order: the
// job type's override, then the global llm_model, then the provider default.
export async function getLlmSettings(db, jobType = null) {
  const config = await getConfig(db);
  const override = jobType ? config[`llm_model_${jobType}`] : '';
  return {
    provider: config.llm_provider,
    model: override || config.llm_model || DEFAULT_MODELS[config.llm_provider] || null,
  };
}
