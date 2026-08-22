// Accounts, sessions and the credentials a user signs in with.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineAccountsModels(define) {
  const User = define(
    'User',
    {
      id,
      username: { type: DataTypes.TEXT, allowNull: false, unique: true },
      password_hash: { type: DataTypes.TEXT, allowNull: false },
      is_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      must_change_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Token allowance per budget window (migration 021). NULL takes the
      // configured default; 0 lifts the ceiling for this user alone.
      token_budget: { type: DataTypes.BIGINT },
      // The user's own LLM provider/model choice (migration 023). Blank falls
      // back to the admin-configured default. llm_models is a JSON object of
      // per-job-type model overrides ({"extract_manual": "claude-haiku-4-5"}).
      llm_provider: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      llm_model: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      llm_models: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
    },
    { tableName: 'users', createdAt: 'created_at', updatedAt: false }
  );

  // One user's authorization of one LLM provider (migration 023).
  // `credentials` is encrypted JSON — services/llmAccounts.js holds the key
  // and is the only reader.
  const UserLlmAccount = define(
    'UserLlmAccount',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      provider: { type: DataTypes.TEXT, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      credentials: { type: DataTypes.TEXT, allowNull: false },
      expires_at: { type: DataTypes.DATE },
      paused_until: { type: DataTypes.DATE },
      paused_reason: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    },
    { tableName: 'user_llm_accounts', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Session = define(
    'Session',
    {
      id,
      token: { type: DataTypes.TEXT, allowNull: false, unique: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'sessions', createdAt: 'created_at', updatedAt: false }
  );

  const AppConfig = define(
    'AppConfig',
    {
      key: { type: DataTypes.TEXT, primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'app_config', timestamps: false }
  );

  // An application allowed to obtain a device token. Public clients only —
  // see migration 013.
  const OAuthClient = define(
    'OAuthClient',
    {
      id,
      client_id: { type: DataTypes.TEXT, allowNull: false, unique: true },
      name: { type: DataTypes.TEXT, allowNull: false },
      scopes: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'oscilloscope' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'oauth_clients', createdAt: 'created_at', updatedAt: false }
  );

  // One in-flight device authorization grant (RFC 8628).
  const DeviceAuthorization = define(
    'DeviceAuthorization',
    {
      id,
      client_id: { type: DataTypes.TEXT, allowNull: false },
      device_code_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
      user_code: { type: DataTypes.TEXT, allowNull: false, unique: true },
      scopes: { type: DataTypes.TEXT, allowNull: false },
      device_name: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      user_id: { type: DataTypes.INTEGER },
      interval_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
      last_polled_at: { type: DataTypes.DATE },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'device_authorizations', createdAt: 'created_at', updatedAt: false }
  );

  // An issued device credential; token values are stored hashed.
  const DeviceToken = define(
    'DeviceToken',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      client_id: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      access_token_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
      refresh_token_hash: { type: DataTypes.TEXT, unique: true },
      scopes: { type: DataTypes.TEXT, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE },
      last_seen_at: { type: DataTypes.DATE },
    },
    { tableName: 'device_tokens', createdAt: 'created_at', updatedAt: false }
  );

  // One record shown to one other user, or to everyone when user_id is NULL
  // (migration 019). Read access only: an owner shares what they made, and
  // stays the only one who can change it. resource_id is a soft reference into
  // whichever table resource_type names.
  const Share = define(
    'Share',
    {
      id,
      resource_type: { type: DataTypes.TEXT, allowNull: false },
      resource_id: { type: DataTypes.INTEGER, allowNull: false },
      owner_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
    },
    { tableName: 'shares', createdAt: 'created_at', updatedAt: false }
  );

  // One model run and what it spent (migration 021). job_id is a soft
  // reference: jobs are deleted, the spending stays.
  const LlmUsage = define(
    'LlmUsage',
    {
      id,
      user_id: { type: DataTypes.INTEGER },
      job_id: { type: DataTypes.INTEGER },
      job_type: { type: DataTypes.TEXT },
      provider: { type: DataTypes.TEXT, allowNull: false },
      model: { type: DataTypes.TEXT },
      input_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cache_read_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cache_write_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      output_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      total_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cost_usd: { type: DataTypes.DOUBLE },
    },
    { tableName: 'llm_usage', createdAt: 'created_at', updatedAt: false }
  );

  return { User, UserLlmAccount, Session, AppConfig, OAuthClient, DeviceAuthorization, DeviceToken, Share, LlmUsage };
}
