import { PROVIDERS, DEFAULT_MODELS } from './llm.js';

export const CONFIG_DEFAULTS = {
  llm_provider: 'claude',
  llm_model: '',
};

export async function getConfig(db) {
  const { rows } = await db.query('SELECT key, value FROM app_config');
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) config[row.key] = row.value;
  return config;
}

export async function setConfig(db, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!(key in CONFIG_DEFAULTS)) throw new Error(`Unknown config key: ${key}`);
    if (key === 'llm_provider' && !PROVIDERS.includes(value)) {
      throw new Error(`Invalid llm_provider: ${value}`);
    }
    const result = await db.query('UPDATE app_config SET value = $2 WHERE key = $1', [
      key,
      String(value),
    ]);
    if (result.rowCount === 0) {
      await db.query('INSERT INTO app_config (key, value) VALUES ($1, $2)', [key, String(value)]);
    }
  }
  return getConfig(db);
}

// Provider/model pair for creating an LLM backend; empty model falls back to
// the provider default.
export async function getLlmSettings(db) {
  const config = await getConfig(db);
  return {
    provider: config.llm_provider,
    model: config.llm_model || DEFAULT_MODELS[config.llm_provider] || null,
  };
}
