// What each model run cost, and the budget that limits it.
//
// Both provider CLIs report the tokens a run spent — claude under
// `--output-format json`, codex in its `--json` event log — and neither
// reports anything unless asked. Asking, and keeping the answer, is what makes
// it possible to say who is spending the shared subscription and to stop one
// user from spending all of it.
//
// One row per CLI invocation, not per job: find_manual alone can call the
// model more than once, and a job that fails on its third attempt spent tokens
// on the first two. The job is recorded for context, as a soft reference —
// jobs are deleted by hand and pruned, and the spending still happened.

export const description = 'what each model run spent, and the budget that limits it';

export async function up({ sql }) {
  await sql`
CREATE TABLE llm_usage (
  id SERIAL PRIMARY KEY,
  -- Who the run was for. NULL only for a run nothing was able to attribute,
  -- which nothing should be: every job carries the user who caused it.
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER,
  job_type TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  -- Input tokens the provider charged fresh, and the cached ones beside them.
  -- Codex counts its cached tokens inside the input figure; llm.js subtracts
  -- them back out so a column means the same thing whichever CLI wrote it.
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- The four columns added up, stored rather than summed on every read: it is
  -- what budgets are counted in, and the queue asks for it on every pass.
  total_tokens INTEGER NOT NULL DEFAULT 0,
  -- What the provider says the run would have cost at list price, where it
  -- says so at all (claude does, codex does not). On a subscription login
  -- nothing is billed per token, so this is a comparison figure and not an
  -- amount anybody owes — which is why budgets are counted in tokens.
  cost_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "What has this user spent since <time>" is the query the queue runs before
-- claiming work and the usage page runs to draw itself.
CREATE INDEX llm_usage_user_created_idx ON llm_usage (user_id, created_at);
CREATE INDEX llm_usage_created_idx ON llm_usage (created_at);
CREATE INDEX llm_usage_job_idx ON llm_usage (job_id);

-- A per-user ceiling in tokens, over the window the admin configures
-- (app_config: token_budget_default, token_budget_period). NULL means "use
-- the default", which is how a user gets the ordinary allowance without
-- anybody setting anything; 0 means this user has no ceiling at all.
ALTER TABLE users ADD COLUMN token_budget BIGINT;
`;
}

export async function down({ dropColumn, dropTable }) {
  await dropColumn('users', 'token_budget');
  await dropTable('llm_usage');
}
