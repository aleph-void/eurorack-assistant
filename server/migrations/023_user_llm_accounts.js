// Per-user LLM provider accounts.
//
// The app runs its model calls through locally installed agent CLIs on a
// subscription login (services/llm.js). Until now that login was the
// server's own — one shared subscription paying for everyone. These rows
// make the login the user's: each user authorizes the app against their own
// provider account, and every CLI run a job makes is executed with that
// user's credentials.
//
// One row per user per provider. `credentials` is an encrypted JSON blob
// (AES-256-GCM, key held outside the database — services/llmAccounts.js), so
// a database export does not carry usable tokens with it.

export const description = 'per-user LLM accounts and model choice';

export async function up({ sql }) {
  await sql`
CREATE TABLE user_llm_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  -- How the credential was obtained, which decides how it is used:
  --   'oauth'     — claude: access + refresh token pair from the in-app
  --                 authorization flow; the app refreshes it itself
  --   'token'     — claude: a long-lived token the user made with
  --                 \`claude setup-token\` and pasted in
  --   'api_key'   — either provider: a plain API key
  --   'auth_json' — codex: the ~/.codex/auth.json a \`codex login\` wrote,
  --                 pasted in; the CLI refreshes it in its own home dir
  kind TEXT NOT NULL,
  credentials TEXT NOT NULL,
  -- When the current access token stops working (oauth only); the app
  -- refreshes shortly before rather than after.
  expires_at TIMESTAMPTZ,
  -- This account reported its subscription out of tokens. The user's queued
  -- jobs wait until the pause lifts; other users' accounts are unaffected
  -- (the global queue pause remains for work nobody owns).
  paused_until TIMESTAMPTZ,
  paused_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- The user's own choice of provider and model. Blank falls back to the
-- admin-configured default (app_config llm_provider / llm_model).
ALTER TABLE users ADD COLUMN llm_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN llm_model TEXT NOT NULL DEFAULT '';
-- Per-job-type model overrides, a JSON object of job type -> model name
-- (e.g. {"extract_manual": "claude-haiku-4-5"}). The user's own tuning for
-- their own account: a missing or blank entry falls back to llm_model above.
ALTER TABLE users ADD COLUMN llm_models TEXT NOT NULL DEFAULT '{}';
`;
}

export async function down({ dropColumn, dropTable }) {
  await dropColumn('users', 'llm_provider', 'llm_model', 'llm_models');
  await dropTable('user_llm_accounts');
}
